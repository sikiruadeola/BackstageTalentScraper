import { Actor } from 'apify';

interface Input {
    categoryIds?: string[];
    states?: string[];
    scraperApiKeys: string[];
    reoonKeys?: string[];
    maxPagesPerList?: number;
    maxCreators?: number;
    concurrency?: number;
}

interface Project {
    url: string;
    name: string;
    creatorKey: string;
    state: string;
    location: string;
    category: string;
    goal: number;
    pledged: number;
    percentFunded: number;
    backers: number;
    currency: string;
    deadline: string;
}

interface Creator {
    name: string;
    profileUrl: string;
    slug: string;
    bio: string;
    location: string;
    websites: string[];
    launched: number;
}

interface RunState {
    cursors: Record<string, number>;
    processed: string[];
}

interface Found {
    methods: Set<string>;
    sites: Set<string>;
    pages: Map<string, string>;
    confirmed: boolean;
}

type Mailbox = 'valid' | 'invalid' | 'catch_all' | 'unknown' | 'unchecked';
type Tier = 'A' | 'B' | 'C' | 'REJECT';

interface EmailRow {
    email: string;
    tier: Tier;
    type: string;
    basis: string;
    nameMatch: boolean;
    mailbox: Mailbox;
    confirmed: boolean;
    methods: string[];
    foundOn: string;
}

const STATE_KEY = 'KICKSTARTER_EMAIL_STATE_V2';
const STATE_STORE_NAME = 'kickstarter-email-progress-v2';
const PAGE_SIZE = 12;

const SKIP = [
    'kickstarter.com', 'kck.st', 'instagram.com', 'facebook.com', 'fb.com', 'linkedin.com', 'youtube.com',
    'youtu.be', 'tiktok.com', 'twitter.com', 'x.com', 'vimeo.com', 'imdb.com', 'drive.google.com',
    'docs.google.com', 'spotify.com', 'soundcloud.com', 'pinterest.com', 'snapchat.com', 'twitch.tv',
    'threads.net', 'behance.net', 'patreon.com', 'amazon.com', 'apple.com', 'bit.ly', 'wa.me', 'discord.gg',
    'discord.com', 'github.com', 'medium.com', 'reddit.com', 'google.com',
];
const HUBS = [
    'linktr.ee', 'beacons.ai', 'bio.link', 'carrd.co', 'linkin.bio', 'allmylinks.com', 'campsite.bio',
    'lnk.bio', 'taplink.cc', 'solo.to', 'komi.io', 'stan.store',
];
const FREEMAIL = [
    'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'aol.com', 'live.com', 'me.com',
    'proton.me', 'protonmail.com', 'msn.com', 'mail.com', 'yahoo.co.uk', 'hotmail.co.uk', 'gmx.com',
];
const GENERIC = [
    'info', 'contact', 'hello', 'hi', 'booking', 'bookings', 'mgmt', 'management', 'admin', 'support', 'sales',
    'production', 'productions', 'office', 'team', 'inquiries', 'enquiries', 'press', 'studio', 'mail',
    'general', 'service', 'help', 'contactus', 'clients', 'business', 'agent', 'casting',
];
const JUNK = [
    'sentry', 'wixpress', 'example.', 'domain.com', 'yourdomain', 'schema.org', 'w3.org', 'godaddy',
    'squarespace.com', 'wordpress', 'sample.', 'test.com', 'email.com', 'yoursite', 'mysite', 'company.com',
    'cloudflare', 'jquery', 'gravatar', 'kickstarter.com',
];
const STOP_TOKENS = [
    'the', 'and', 'productions', 'production', 'studio', 'studios', 'films', 'film', 'media', 'official',
    'entertainment', 'photography', 'pictures', 'creative', 'music', 'video', 'llc', 'inc', 'labs', 'tech',
    'games', 'game', 'team', 'works', 'design', 'with', 'for', 'your', 'from', 'that', 'this',
];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

class AllKeysExhausted extends Error {}

class KeyPool {
    private keys: string[];
    private label: string;
    private dead = new Set<string>();

    constructor(keys: string[], label: string) {
        this.keys = keys;
        this.label = label;
    }

    current(): string | null {
        for (const key of this.keys) {
            if (!this.dead.has(key)) return key;
        }
        return null;
    }

    markDead(key: string, reason: string): void {
        if (this.dead.has(key)) return;
        this.dead.add(key);
        console.log(`${this.label} key ending ${key.slice(-4)} retired (${reason}). ${this.keys.length - this.dead.size} left.`);
    }
}

let saPool = new KeyPool([], 'ScraperAPI');
let reoonPool = new KeyPool([], 'Reoon');
let creditsUsed = 0;
const mxCache = new Map<string, boolean | null>();
let reoonLogged = false;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function decodeEntities(s: string): string {
    return s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x2F;/gi, '/')
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)));
}

function safeDecodeURI(s: string): string {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

function hostOf(url: string): string {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return '';
    }
}

function rootDomain(host: string): string {
    let d = host.toLowerCase().split(':')[0];
    if (d.startsWith('www.')) d = d.slice(4);
    const parts = d.split('.');
    const secondLast = parts[parts.length - 2];
    const last = parts[parts.length - 1];
    if (parts.length >= 3 && ['co', 'com', 'org', 'net', 'ac'].includes(secondLast) && last.length === 2) {
        return parts.slice(-3).join('.');
    }
    return parts.slice(-2).join('.');
}

async function sa(
    url: string,
    opts: { render?: boolean },
): Promise<{ status: number; text: string }> {
    for (let attempt = 0; attempt < 5; attempt++) {
        const key = saPool.current();
        if (!key) throw new AllKeysExhausted('No working ScraperAPI keys left.');

        const params = new URLSearchParams({ api_key: key, url });
        if (opts.render) params.set('render', 'true');

        try {
            const res = await fetch(`https://api.scraperapi.com/?${params.toString()}`, {
                signal: AbortSignal.timeout(150_000),
            });
            const text = await res.text();
            if (res.status === 401 || res.status === 403) {
                saPool.markDead(key, `HTTP ${res.status}`);
                continue;
            }
            if (res.status === 429) {
                await sleep(4_000);
                continue;
            }
            creditsUsed += Number(res.headers.get('sa-credit-cost') ?? 0);
            return { status: res.status, text };
        } catch {
            await sleep(1_500);
        }
    }
    return { status: 0, text: '' };
}

async function getPage(url: string, render: boolean): Promise<string | null> {
    for (let i = 0; i < 2; i++) {
        const r = await sa(url, { render });
        if (r.status === 200) return r.text;
    }
    return null;
}

interface RawProject {
    name?: string;
    state?: string;
    goal?: number | string;
    pledged?: number | string;
    percent_funded?: number;
    backers_count?: number;
    currency?: string;
    deadline?: number;
    static_usd_rate?: number;
    creator?: { slug?: string; name?: string };
    location?: { displayable_name?: string };
    category?: { name?: string };
    urls?: { web?: { project?: string } };
}

async function fetchListing(categoryId: string, state: string, page: number): Promise<{ projects: Project[]; total: number }> {
    const url =
        `https://www.kickstarter.com/discover/advanced.json?category_id=${encodeURIComponent(categoryId)}` +
        `&state=${encodeURIComponent(state)}&sort=newest&page=${page}`;

    for (let attempt = 0; attempt < 2; attempt++) {
        const r = await sa(url, { render: true });
        if (r.status !== 200) continue;

        const start = r.text.indexOf('{"projects"');
        const end = r.text.lastIndexOf('}');
        if (start < 0 || end <= start) continue;

        try {
            const json = JSON.parse(r.text.slice(start, end + 1)) as { projects?: RawProject[]; total_hits?: number };
            const projects: Project[] = [];
            for (const p of json.projects ?? []) {
                const projectUrl = p.urls?.web?.project;
                if (!projectUrl) continue;
                const pathPart = /\/projects\/([^/]+)\//.exec(projectUrl)?.[1] ?? projectUrl;
                const rate = Number(p.static_usd_rate ?? 1);
                projects.push({
                    url: projectUrl.split('?')[0],
                    name: p.name ?? '',
                    creatorKey: (p.creator?.slug ?? pathPart).toLowerCase(),
                    state: p.state ?? '',
                    location: p.location?.displayable_name ?? '',
                    category: p.category?.name ?? '',
                    goal: Math.round(Number(p.goal ?? 0) * rate),
                    pledged: Math.round(Number(p.pledged ?? 0) * rate),
                    percentFunded: Math.round(Number(p.percent_funded ?? 0)),
                    backers: Number(p.backers_count ?? 0),
                    currency: 'USD',
                    deadline: p.deadline ? new Date(p.deadline * 1000).toISOString().slice(0, 10) : '',
                });
            }
            return { projects, total: Number(json.total_hits ?? 0) };
        } catch {
            // try again
        }
    }
    return { projects: [], total: 0 };
}

function parseCreatorTab(html: string): Creator | null {
    const u = decodeEntities(html)
        .replace(/\\"/g, '"')
        .replace(/\\+u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
    // the profile block has a text id (the project block has a numeric id), so look for the quoted id
    const start = u.indexOf('"creator":{"id":"');
    if (start < 0) {
        console.log(`No creator profile block found (page length ${html.length}).`);
        return null;
    }
    const scope = u.slice(start, start + 9000);
    const name = /"creator":\{"id":"[^"]*","name":"([^"]*)"/.exec(scope)?.[1];
    if (!name) {
        console.log(`Creator name not readable: ${scope.slice(0, 160)}`);
        return null;
    }

    const profileUrl = /"url":"(https:\/\/www\.kickstarter\.com\/profile\/[^"]*)"/.exec(scope)?.[1] ?? '';
    const slug = (/\/profile\/([^/?"]+)/.exec(profileUrl)?.[1] ?? name).toLowerCase();
    const bioRaw = /"biography":(?:null|"([\s\S]*?)","isFacebookConnected")/.exec(scope)?.[1] ?? '';
    const bio = bioRaw.replace(/\\+[rn]/g, ' ').replace(/\s+/g, ' ').trim();
    const location = /"displayableName":"([^"]*)"/.exec(scope)?.[1] ?? '';
    const websitesBlock = /"websites":\[([\s\S]*?)\]/.exec(scope)?.[1] ?? '';
    const websites = Array.from(new Set(Array.from(websitesBlock.matchAll(/https?:\/\/[^"\\\s]+/g)).map((x) => x[0])));
    const launched = Number(/"launchedProjects":\{"totalCount":(\d+)\}/.exec(scope)?.[1] ?? 0);

    return { name, profileUrl, slug, bio, location, websites, launched };
}

function cleanEmail(raw: string): string | null {
    const e = raw.trim().replace(/^\.+|\.+$/g, '').toLowerCase();
    if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(e)) return null;
    if (/\.(png|jpe?g|gif|webp|svg|js|css|woff2?)$/.test(e)) return null;
    if (JUNK.some((j) => e.includes(j))) return null;
    if (/^(your|name|user|email|first|john|example)@/.test(e)) return null;
    return e;
}

function extractEmails(html: string): Array<{ email: string; method: string }> {
    const found: Array<{ email: string; method: string }> = [];
    const push = (raw: string, method: string): void => {
        const e = cleanEmail(raw);
        if (e) found.push({ email: e, method });
    };

    for (const m of html.matchAll(/href=["']mailto:([^"'?]+)/gi)) {
        push(safeDecodeURI(decodeEntities(m[1])), 'mailto');
    }
    for (const m of html.matchAll(/data-cfemail="([0-9a-fA-F]+)"/g)) {
        const hex = m[1];
        const key = parseInt(hex.slice(0, 2), 16);
        let s = '';
        for (let i = 2; i + 1 < hex.length; i += 2) {
            s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
        }
        push(s, 'cfemail');
    }
    for (const m of html.matchAll(/"email"\s*:\s*"([^"]+)"/g)) {
        push(m[1].replace('mailto:', ''), 'jsonld');
    }

    const text = safeDecodeURI(decodeEntities(html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')));
    for (const m of text.matchAll(EMAIL_RE)) {
        push(m[0], 'text');
    }
    for (const m of text.matchAll(/([A-Za-z0-9._%+-]+)\s*[[({]\s*at\s*[\])}]\s*([A-Za-z0-9-]+)\s*[[({]\s*dot\s*[\])}]\s*([A-Za-z]{2,})/gi)) {
        push(`${m[1]}@${m[2]}.${m[3]}`, 'obfuscated');
    }
    return found;
}

function pageCandidates(site: string, html: string): string[] {
    const base = rootDomain(hostOf(site));
    const found: string[] = [];
    for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
        const href = m[1];
        if (!/contact|about|connect|hire|book|inquir|reach|press|work-with/i.test(href)) continue;
        if (/^(mailto:|tel:|javascript)/i.test(href)) continue;
        try {
            const u = new URL(href, site);
            if (rootDomain(u.hostname) === base) found.push(u.toString().split('#')[0]);
        } catch {
            // ignore bad links
        }
    }
    const unique = Array.from(new Set(found));
    if (unique.length === 0) {
        try {
            return [new URL('/contact', site).toString(), new URL('/about', site).toString()];
        } catch {
            return [];
        }
    }
    return unique.slice(0, 3);
}

function nameTokens(...sources: string[]): string[] {
    const tokens = new Set<string>();
    for (const source of sources) {
        for (const t of source.toLowerCase().match(/[a-z]{4,}/g) ?? []) {
            if (!STOP_TOKENS.includes(t)) tokens.add(t);
        }
    }
    return Array.from(tokens);
}

async function hasMx(domain: string): Promise<boolean | null> {
    const cached = mxCache.get(domain);
    if (cached !== undefined) return cached;
    let result: boolean | null = null;
    try {
        const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`, {
            headers: { accept: 'application/dns-json' },
            signal: AbortSignal.timeout(15_000),
        });
        const json = (await res.json()) as { Answer?: Array<{ type: number }> };
        const hasAnswer = (json.Answer ?? []).some((a) => a.type === 15);
        if (hasAnswer) {
            result = true;
        } else {
            const resA = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=A`, {
                headers: { accept: 'application/dns-json' },
                signal: AbortSignal.timeout(15_000),
            });
            const jsonA = (await resA.json()) as { Answer?: unknown[] };
            result = (jsonA.Answer ?? []).length > 0 ? null : false;
        }
    } catch {
        result = null;
    }
    mxCache.set(domain, result);
    return result;
}

async function reoonVerify(email: string): Promise<Mailbox> {
    for (let attempt = 0; attempt < 5; attempt++) {
        const key = reoonPool.current();
        if (!key) return 'unchecked';
        try {
            const res = await fetch(
                `https://emailverifier.reoon.com/api/v1/verify?email=${encodeURIComponent(email)}&key=${encodeURIComponent(key)}&mode=power`,
                { signal: AbortSignal.timeout(90_000) },
            );
            const text = await res.text();
            if (!reoonLogged) {
                reoonLogged = true;
                console.log(`First Reoon response: ${text.slice(0, 600)}`);
            }
            let json: { status?: string; reason?: string; message?: string } = {};
            try {
                json = JSON.parse(text) as typeof json;
            } catch {
                json = {};
            }
            const status = (json.status ?? '').toLowerCase();
            if (res.status === 401 || res.status === 403 || res.status === 429 || status === 'error') {
                reoonPool.markDead(key, json.reason ?? json.message ?? `HTTP ${res.status}`);
                continue;
            }
            if (status === 'valid' || status === 'safe' || status === 'role_account' || status === 'inbox_full') return 'valid';
            if (status === 'catch_all') return 'catch_all';
            if (['invalid', 'disabled', 'disposable', 'spamtrap'].includes(status)) return 'invalid';
            return 'unknown';
        } catch {
            await sleep(2_000);
        }
    }
    return 'unknown';
}

function decideTier(x: {
    mailbox: Mailbox;
    nameMatch: boolean;
    domainMatch: boolean;
    free: boolean;
    strong: boolean;
    confirmed: boolean;
}): Tier {
    if (x.mailbox === 'invalid') return 'REJECT';
    const ours = x.nameMatch || x.domainMatch;
    if (ours && x.strong && x.confirmed && x.mailbox !== 'catch_all' && x.mailbox !== 'unknown') return 'A';
    if (ours || x.free) return 'B';
    return 'C';
}

async function investigate(creator: Creator, projectName: string): Promise<EmailRow[]> {
    const bioUrls = Array.from(creator.bio.matchAll(/https?:\/\/[^\s"'<>)]+/g)).map((m) => m[0]);
    const sites = Array.from(new Set([...creator.websites, ...bioUrls]))
        .filter((l) => !SKIP.some((s) => hostOf(l).includes(s)))
        .slice(0, 3);
    const evidence = new Map<string, Found>();
    const htmls = new Map<string, string>();

    const add = (html: string, url: string, how: string): void => {
        const site = rootDomain(hostOf(url));
        for (const { email, method } of extractEmails(html)) {
            let f = evidence.get(email);
            if (!f) {
                f = { methods: new Set(), sites: new Set(), pages: new Map(), confirmed: false };
                evidence.set(email, f);
            }
            f.methods.add(method);
            f.sites.add(site);
            f.pages.set(url, how);
        }
    };

    // emails the creator wrote in their own Kickstarter biography
    add(creator.bio, creator.profileUrl, 'bio');

    const queue = [...sites];
    const seen = new Set<string>();
    let fetched = 0;
    while (queue.length > 0 && fetched < 8) {
        const url = queue.shift() as string;
        if (seen.has(url)) continue;
        seen.add(url);
        const html = await getPage(url, false);
        fetched++;
        if (!html) continue;
        htmls.set(url, html);
        add(html, url, 'plain');

        const host = hostOf(url);
        if (HUBS.some((h) => host.includes(h))) {
            for (const m of html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)) {
                const h2 = hostOf(m[1]);
                if (h2 && !SKIP.some((s) => h2.includes(s)) && !HUBS.some((h) => h2.includes(h)) && !seen.has(m[1]) && queue.length < 4) {
                    queue.push(m[1]);
                }
            }
        } else if (sites.includes(url)) {
            queue.push(...pageCandidates(url, html).filter((c) => !seen.has(c)).slice(0, 2));
        }
    }

    if (evidence.size === 0 && sites.length > 0) {
        const targets: string[] = [];
        for (const s of sites.slice(0, 2)) {
            targets.push(s);
            targets.push(...pageCandidates(s, htmls.get(s) ?? '').slice(0, 1));
        }
        for (const url of Array.from(new Set(targets)).slice(0, 4)) {
            const html = await getPage(url, true);
            if (html) add(html, url, 'rendered');
        }
    }

    // second independent pass: fetch one page per email again and make sure it is still there
    for (const [email, f] of evidence) {
        const [url, how] = Array.from(f.pages.entries())[0];
        if (how === 'bio') {
            f.confirmed = true;
            continue;
        }
        const html = await getPage(url, how === 'rendered');
        f.confirmed = html !== null && extractEmails(html).some((x) => x.email === email);
    }

    const tokens = nameTokens(creator.name, creator.slug, projectName);
    const siteRoots = new Set(sites.map((s) => rootDomain(hostOf(s))));
    const rows: EmailRow[] = [];

    for (const [email, f] of evidence) {
        const [local, domain] = email.split('@');
        const localLetters = local.replace(/[^a-z]/g, '');
        const nameMatch = tokens.some((t) => localLetters.includes(t));
        const domainMatch = siteRoots.has(rootDomain(domain));
        const free = FREEMAIL.includes(domain);
        const fromBio = Array.from(f.pages.values()).includes('bio');
        const strong = ['mailto', 'cfemail', 'jsonld'].some((m) => f.methods.has(m)) || f.pages.size >= 2 || fromBio;
        const generic = GENERIC.includes(localLetters);

        let mailbox: Mailbox = 'unchecked';
        const mx = await hasMx(domain);
        if (mx === false) {
            mailbox = 'invalid';
        } else if (nameMatch || domainMatch || free || fromBio) {
            mailbox = await reoonVerify(email);
        }

        const tier = decideTier({ mailbox, nameMatch, domainMatch, free, strong, confirmed: f.confirmed });
        rows.push({
            email,
            tier,
            type: generic ? 'business inbox' : nameMatch || free ? 'personal' : 'other',
            basis: domainMatch ? 'own domain' : free ? 'freemail' : 'third party',
            nameMatch,
            mailbox,
            confirmed: f.confirmed,
            methods: Array.from(f.methods),
            foundOn: Array.from(f.pages.keys())[0],
        });
    }

    const order: Record<Tier, number> = { A: 0, B: 1, C: 2, REJECT: 3 };
    rows.sort((a, b) => order[a.tier] - order[b.tier]);
    return rows;
}

async function loadState(): Promise<RunState> {
    const store = await Actor.openKeyValueStore(STATE_STORE_NAME);
    const saved = await store.getValue<RunState>(STATE_KEY);
    return saved ?? { cursors: {}, processed: [] };
}

async function saveState(state: RunState): Promise<void> {
    const store = await Actor.openKeyValueStore(STATE_STORE_NAME);
    await store.setValue(STATE_KEY, state);
}

await Actor.init();

try {
    const input = (await Actor.getInput()) as Input | null;
    if (!input) throw new Error('Input is required.');
    const keys = (input.scraperApiKeys ?? []).map((k) => k.trim()).filter((k) => k.length > 0);
    if (keys.length === 0) throw new Error('Add at least one ScraperAPI key.');

    saPool = new KeyPool(keys, 'ScraperAPI');
    reoonPool = new KeyPool((input.reoonKeys ?? []).map((k) => k.trim()).filter((k) => k.length > 0), 'Reoon');

    const categories = (input.categoryIds && input.categoryIds.length > 0 ? input.categoryIds : ['16']).map(String);
    const states = input.states && input.states.length > 0 ? input.states : ['live', 'upcoming'];
    const maxPages = Math.max(0, Number(input.maxPagesPerList ?? 0));
    const maxCreators = Math.max(0, Number(input.maxCreators ?? 0));
    const concurrency = Math.min(5, Math.max(1, Number(input.concurrency ?? 3)));

    const state = await loadState();
    const processed = new Set(state.processed);

    console.log('==============================');
    console.log('KICKSTARTER EMAIL FINDER');
    console.log('==============================');
    console.log(`Categories: ${categories.join(', ')} | States: ${states.join(', ')}`);
    console.log(`ScraperAPI keys: ${keys.length}, Reoon keys: ${input.reoonKeys?.length ?? 0}, concurrency: ${concurrency}`);
    console.log(`Creators already done: ${processed.size}`);

    let totalCreators = 0;
    let totalEmails = 0;
    let stop = false;

    try {
        for (const categoryId of categories) {
            for (const campaignState of states) {
                if (stop) break;
                const listKey = `${categoryId}:${campaignState}`;
                let page = state.cursors[listKey] ?? 1;
                let emptyPages = 0;
                let pagesDone = 0;

                while (!stop && (maxPages === 0 || pagesDone < maxPages)) {
                    console.log(`\nLISTING category ${categoryId}, ${campaignState}, page ${page}`);
                    const { projects, total } = await fetchListing(categoryId, campaignState, page);
                    console.log(`Projects found: ${projects.length} (list total ${total})`);

                    if (projects.length === 0) {
                        emptyPages++;
                        if (emptyPages >= 2 || page > Math.ceil(total / PAGE_SIZE) + 1) {
                            console.log('End of this list. The next run starts it again from page 1.');
                            state.cursors[listKey] = 1;
                            await saveState({ cursors: state.cursors, processed: Array.from(processed) });
                            break;
                        }
                        page++;
                        continue;
                    }
                    emptyPages = 0;

                    const todo = projects.filter((p) => !processed.has(p.creatorKey));

                    for (let i = 0; i < todo.length; i += concurrency) {
                        if (maxCreators > 0 && totalCreators >= maxCreators) {
                            stop = true;
                            break;
                        }
                        const room = maxCreators > 0 ? maxCreators - totalCreators : undefined;
                        const batch = todo.slice(i, i + concurrency).slice(0, room);

                        const counts = await Promise.all(
                            batch.map(async (project) => {
                                const html = await getPage(`${project.url}/creator`, true);
                                if (!html) {
                                    console.log(`Could not load creator tab for ${project.url}.`);
                                    return 0;
                                }
                                const creator = parseCreatorTab(html);
                                if (!creator) {
                                    console.log(`Could not read creator data for ${project.url}.`);
                                    return 0;
                                }

                                const rows = await investigate(creator, project.name);
                                const keep = rows.filter((r) => r.tier === 'A' || r.tier === 'B');
                                for (const r of keep) {
                                    await Actor.pushData({
                                        creator: creator.name,
                                        kickstarterProfile: creator.profileUrl,
                                        project: project.name,
                                        projectUrl: project.url,
                                        campaignState: project.state,
                                        category: project.category,
                                        location: project.location || creator.location,
                                        goalUsd: project.goal,
                                        pledgedUsd: project.pledged,
                                        percentFunded: project.percentFunded,
                                        backers: project.backers,
                                        deadline: project.deadline,
                                        email: r.email,
                                        tier: r.tier,
                                        type: r.type,
                                        basis: r.basis,
                                        nameMatch: r.nameMatch,
                                        mailboxCheck: r.mailbox,
                                        confirmedTwice: r.confirmed,
                                        methods: r.methods,
                                        foundOn: r.foundOn,
                                        websites: creator.websites,
                                    });
                                }
                                console.log(`${creator.name}: ${creator.websites.length} websites, ${keep.length} email(s) kept, ${rows.length - keep.length} dropped.`);
                                return keep.length;
                            }),
                        );

                        for (const p of batch) processed.add(p.creatorKey);
                        totalCreators += batch.length;
                        totalEmails += counts.reduce((a, b) => a + b, 0);
                        state.cursors[listKey] = page;
                        await saveState({ cursors: state.cursors, processed: Array.from(processed) });
                        console.log(`PROGRESS: creators=${totalCreators}, emails=${totalEmails}, credits used=${creditsUsed}`);
                    }

                    if (stop) break;
                    page++;
                    pagesDone++;
                    state.cursors[listKey] = page;
                    await saveState({ cursors: state.cursors, processed: Array.from(processed) });
                }
            }
        }
    } catch (error) {
        if (error instanceof AllKeysExhausted) {
            console.log('All ScraperAPI keys are used up. Progress is saved. Add new keys and run again to continue.');
        } else {
            throw error;
        }
    }

    console.log('\n==============================');
    console.log('FINISHED');
    console.log('==============================');
    console.log(`Creators processed this run: ${totalCreators}`);
    console.log(`Emails saved: ${totalEmails}`);
    console.log(`ScraperAPI credits used this run: ${creditsUsed}`);
} catch (error) {
    console.error(`FATAL ACTOR ERROR: ${errorMessage(error)}`);
    throw error;
} finally {
    await Actor.exit();
}
