import { Actor } from 'apify';

interface Input {
    startUrl: string;
    backstageCookie: string;
    scraperApiKeys: string[];
    reoonKeys?: string[];
    startPage?: number;
    maxPages?: number;
    maxProfiles?: number;
    concurrency?: number;
}

interface Card {
    id: string;
    name: string;
}

interface Panel {
    profile: string | null;
    links: string[];
}

interface RunState {
    cursor: number;
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

const STATE_KEY = 'BACKSTAGE_EMAIL_STATE';
const STATE_STORE_NAME = 'backstage-email-progress';

const SKIP = [
    'instagram.com', 'facebook.com', 'fb.com', 'linkedin.com', 'youtube.com', 'youtu.be', 'tiktok.com',
    'twitter.com', 'x.com', 'vimeo.com', 'imdb.com', 'drive.google.com', 'docs.google.com', 'spotify.com',
    'soundcloud.com', 'pinterest.com', 'snapchat.com', 'twitch.tv', 'threads.net', 'behance.net',
    'patreon.com', 'amazon.com', 'apple.com', 'bit.ly', 'wa.me',
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
    'cloudflare', 'jquery', 'gravatar',
];
const STOP_TOKENS = [
    'crew', 'the', 'and', 'productions', 'production', 'studio', 'studios', 'films', 'film', 'media',
    'official', 'entertainment', 'photography', 'photographer', 'pictures', 'creative', 'music', 'video',
    'llc', 'inc',
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

function toCookieHeader(raw: string): string {
    const text = raw.trim();
    if (!text.startsWith('[')) return text;
    const list = JSON.parse(text) as Array<{ name: string; value: string; domain?: string }>;
    return list
        .filter((c) => !c.domain || c.domain.includes('backstage.com'))
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');
}

function buildPageUrl(baseUrl: string, pageNumber: number): string {
    const url = new URL(baseUrl);
    url.searchParams.set('page', String(pageNumber));
    return url.toString();
}

async function sa(
    url: string,
    opts: { render?: boolean; cookie?: string; instructions?: unknown; waitFor?: string },
): Promise<{ status: number; text: string }> {
    for (let attempt = 0; attempt < 5; attempt++) {
        const key = saPool.current();
        if (!key) throw new AllKeysExhausted('No working ScraperAPI keys left.');

        const params = new URLSearchParams({ api_key: key, url });
        const headers: Record<string, string> = {};
        if (opts.render) params.set('render', 'true');
        if (opts.waitFor) params.set('wait_for_selector', opts.waitFor);
        if (opts.cookie) {
            params.set('keep_headers', 'true');
            headers['Cookie'] = opts.cookie;
        }
        if (opts.instructions) {
            params.set('keep_headers', 'true');
            headers['x-sapi-instruction_set'] = JSON.stringify(opts.instructions);
        }

        try {
            const res = await fetch(`https://api.scraperapi.com/?${params.toString()}`, {
                headers,
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

function parseCards(html: string): Card[] {
    const cards: Card[] = [];
    const re = /name="talent-profile-id"[^>]*value="(\d+)"[\s\S]*?tw-font-header-bold[^>]*>([\s\S]*?)<\/div>/g;
    for (const m of html.matchAll(re)) {
        const name = decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim();
        cards.push({ id: m[1], name });
    }
    return cards;
}

async function fetchListing(startUrl: string, cookie: string, pageNumber: number): Promise<Card[]> {
    for (let attempt = 0; attempt < 3; attempt++) {
        const r = await sa(buildPageUrl(startUrl, pageNumber), {
            render: true,
            cookie,
            waitFor: '.profile-card',
        });
        if (r.status === 200) {
            const cards = parseCards(r.text);
            if (cards.length > 0) return cards;
        }
    }
    return [];
}

async function fetchPanel(startUrl: string, cookie: string, pageNumber: number, n: number): Promise<Panel> {
    const xp = `(//div[contains(@class,'profile-card')]//div[contains(@class,'tw-font-header-bold')])[${n}]`;
    const instructions = [
        { type: 'wait_for_selector', selector: { type: 'css', value: '.profile-card' }, timeout: 20 },
        { type: 'click', selector: { type: 'xpath', value: xp } },
        { type: 'wait', value: 5 },
    ];

    for (let attempt = 0; attempt < 3; attempt++) {
        const r = await sa(buildPageUrl(startUrl, pageNumber), { render: true, cookie, instructions });
        if (r.status !== 200) continue;

        const html = r.text;
        const link = /<a href="(\/[^"]*)"[^>]*>View profile in a new tab/.exec(html);
        const i = html.indexOf('id="profilelinks"');
        const links: string[] = [];
        if (i >= 0) {
            for (const m of html.slice(i, i + 4000).matchAll(/href="([^"]+)"/g)) {
                const href = decodeEntities(m[1]);
                if (href.startsWith('http') && !href.includes('backstage.com') && !links.includes(href)) {
                    links.push(href);
                }
            }
        }
        return { profile: link ? `https://www.backstage.com${link[1]}` : null, links };
    }
    return { profile: null, links: [] };
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

function nameTokens(name: string, profileUrl: string): string[] {
    const tokens = new Set<string>();
    let path = '';
    try {
        path = new URL(profileUrl).pathname;
    } catch {
        path = '';
    }
    for (const source of [name, path]) {
        for (const t of source.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
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
                console.log(`First Reoon response (check the format): ${text.slice(0, 400)}`);
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

async function investigate(name: string, profileUrl: string, links: string[]): Promise<EmailRow[]> {
    const sites = links
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
        const html = await getPage(url, how === 'rendered');
        f.confirmed = html !== null && extractEmails(html).some((x) => x.email === email);
    }

    const tokens = nameTokens(name, profileUrl);
    const siteRoots = new Set(sites.map((s) => rootDomain(hostOf(s))));
    const rows: EmailRow[] = [];

    for (const [email, f] of evidence) {
        const [local, domain] = email.split('@');
        const localLetters = local.replace(/[^a-z]/g, '');
        const nameMatch = tokens.some((t) => localLetters.includes(t));
        const domainMatch = siteRoots.has(rootDomain(domain));
        const free = FREEMAIL.includes(domain);
        const strong = ['mailto', 'cfemail', 'jsonld'].some((m) => f.methods.has(m)) || f.pages.size >= 2;
        const generic = GENERIC.includes(localLetters);

        let mailbox: Mailbox = 'unchecked';
        const mx = await hasMx(domain);
        if (mx === false) {
            mailbox = 'invalid';
        } else if (nameMatch || domainMatch || free) {
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
    return saved ?? { cursor: 1, processed: [] };
}

async function saveState(state: RunState): Promise<void> {
    const store = await Actor.openKeyValueStore(STATE_STORE_NAME);
    await store.setValue(STATE_KEY, state);
}

await Actor.init();

try {
    const input = (await Actor.getInput()) as Input | null;
    if (!input || !input.startUrl) throw new Error('startUrl is required.');
    if (!input.backstageCookie) throw new Error('backstageCookie is required.');
    const keys = (input.scraperApiKeys ?? []).map((k) => k.trim()).filter((k) => k.length > 0);
    if (keys.length === 0) throw new Error('Add at least one ScraperAPI key.');

    saPool = new KeyPool(keys, 'ScraperAPI');
    reoonPool = new KeyPool((input.reoonKeys ?? []).map((k) => k.trim()).filter((k) => k.length > 0), 'Reoon');

    const cookie = toCookieHeader(input.backstageCookie);
    const startUrl = input.startUrl.trim();
    const maxPages = Math.max(0, Number(input.maxPages ?? 0));
    const maxProfiles = Math.max(0, Number(input.maxProfiles ?? 0));
    const concurrency = Math.min(5, Math.max(1, Number(input.concurrency ?? 3)));

    const state = await loadState();
    const processed = new Set(state.processed);
    let pageNumber = input.startPage && input.startPage > 0 ? input.startPage : state.cursor;

    console.log('==============================');
    console.log('BACKSTAGE EMAIL FINDER');
    console.log('==============================');
    console.log(`Starting at page ${pageNumber}, ${processed.size} profiles already done.`);
    console.log(`ScraperAPI keys: ${keys.length}, Reoon keys: ${input.reoonKeys?.length ?? 0}, concurrency: ${concurrency}`);

    let totalProcessed = 0;
    let totalEmails = 0;
    let emptyPages = 0;
    let pagesDone = 0;
    let stop = false;

    try {
        while (!stop && (maxPages === 0 || pagesDone < maxPages)) {
            console.log(`\nOPENING PAGE ${pageNumber}`);
            const cards = await fetchListing(startUrl, cookie, pageNumber);
            console.log(`Cards found: ${cards.length}`);

            if (cards.length === 0) {
                emptyPages++;
                if (emptyPages >= 2) {
                    console.log('Two empty pages in a row. Treating this as the end of the list.');
                    break;
                }
                pageNumber++;
                continue;
            }
            emptyPages = 0;

            const todo = cards
                .map((card, i) => ({ card, n: i + 1 }))
                .filter((x) => !processed.has(x.card.id));

            for (let i = 0; i < todo.length; i += concurrency) {
                if (maxProfiles > 0 && totalProcessed >= maxProfiles) {
                    stop = true;
                    break;
                }
                const room = maxProfiles > 0 ? maxProfiles - totalProcessed : undefined;
                const batch = todo.slice(i, i + concurrency).slice(0, room);

                const counts = await Promise.all(
                    batch.map(async ({ card, n }) => {
                        const panel = await fetchPanel(startUrl, cookie, pageNumber, n);
                        if (!panel.profile) {
                            console.log(`No profile panel for ${card.name}.`);
                            return 0;
                        }
                        const rows = panel.links.length > 0 ? await investigate(card.name, panel.profile, panel.links) : [];
                        const keep = rows.filter((r) => r.tier === 'A' || r.tier === 'B');
                        for (const r of keep) {
                            await Actor.pushData({
                                name: card.name,
                                backstageProfile: panel.profile,
                                discoveryPage: pageNumber,
                                email: r.email,
                                tier: r.tier,
                                type: r.type,
                                basis: r.basis,
                                nameMatch: r.nameMatch,
                                mailboxCheck: r.mailbox,
                                confirmedTwice: r.confirmed,
                                methods: r.methods,
                                foundOn: r.foundOn,
                                profileLinks: panel.links,
                            });
                        }
                        console.log(`${card.name}: ${panel.links.length} links, ${keep.length} email(s) kept, ${rows.length - keep.length} dropped.`);
                        return keep.length;
                    }),
                );

                for (const { card } of batch) processed.add(card.id);
                totalProcessed += batch.length;
                totalEmails += counts.reduce((a, b) => a + b, 0);
                await saveState({ cursor: pageNumber, processed: Array.from(processed) });
                console.log(`PROGRESS: profiles=${totalProcessed}, emails=${totalEmails}, credits used=${creditsUsed}`);
            }

            if (stop) break;
            pageNumber++;
            pagesDone++;
            await saveState({ cursor: pageNumber, processed: Array.from(processed) });
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
    console.log(`Profiles processed this run: ${totalProcessed}`);
    console.log(`Emails saved: ${totalEmails}`);
    console.log(`ScraperAPI credits used this run: ${creditsUsed}`);
} catch (error) {
    console.error(`FATAL ACTOR ERROR: ${errorMessage(error)}`);
    throw error;
} finally {
    await Actor.exit();
}
