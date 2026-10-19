import { Actor } from 'apify';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

interface Input {
    startUrl: string;
    authState?: unknown;
    maxPages?: number;
    maxProfiles?: number;
    useResidentialProxy?: boolean;
}

interface Person {
    profileUrl: string;
    name: string;
    discoveryPage: number;
}

interface RunState {
    cursor: number;
    seenProfileUrls: string[];
}

interface Launched {
    browser: Browser;
    context: BrowserContext;
}

const STATE_KEY = 'BACKSTAGE_STATE';
const STATE_STORE_NAME = 'backstage-progress';
const NAVIGATION_TIMEOUT = 120_000;
const BLOCKED_HOSTS = [
    'googletagmanager',
    'google-analytics',
    'doubleclick',
    'googlesyndication',
    'facebook.net',
    'hotjar',
    'intercom',
    'tiktok',
    'hubspot',
    'segment.',
    'parsely',
    'snapchat',
    'redditstatic',
];

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

function normalizeText(value: string | null | undefined): string {
    return (value ?? '').replace(/\s+/g, ' ').trim();
}

async function pause(page: Page, minMs: number, maxMs: number): Promise<void> {
    const waitMs = minMs + Math.floor(Math.random() * (maxMs - minMs));
    await page.waitForTimeout(waitMs);
}

// Cookie Editor exports an array of cookies. Playwright wants a storage state
// object. This accepts either form.
function toStorageState(value: unknown): unknown {
    if (!Array.isArray(value)) return value;

    const cookies = (value as Array<Record<string, unknown>>).map((c) => {
        const rawSame = String(c.sameSite ?? '').toLowerCase();
        const sameSite = rawSame === 'strict' ? 'Strict' : rawSame === 'no_restriction' || rawSame === 'none' ? 'None' : 'Lax';
        const expires = typeof c.expirationDate === 'number' ? c.expirationDate : -1;
        return {
            name: String(c.name),
            value: String(c.value),
            domain: String(c.domain),
            path: String(c.path ?? '/'),
            expires,
            httpOnly: Boolean(c.httpOnly),
            secure: Boolean(c.secure) || sameSite === 'None',
            sameSite,
        };
    });

    return { cookies, origins: [] };
}

function parseAuthState(value: unknown): unknown {
    if (value === undefined || value === null || value === '') {
        throw new Error('authState is required. Paste your Backstage cookie export into the authState input.');
    }

    if (typeof value !== 'string') return toStorageState(value);

    try {
        return toStorageState(JSON.parse(value.trim()));
    } catch (error) {
        throw new Error(`Could not parse authState JSON: ${errorMessage(error)}`);
    }
}

async function loadState(): Promise<RunState> {
    const store = await Actor.openKeyValueStore(STATE_STORE_NAME);
    const saved = await store.getValue<RunState>(STATE_KEY);
    return saved ?? { cursor: 1, seenProfileUrls: [] };
}

async function saveState(state: RunState): Promise<void> {
    const store = await Actor.openKeyValueStore(STATE_STORE_NAME);
    await store.setValue(STATE_KEY, state);
}

function buildPageUrl(baseUrl: string, pageNumber: number): string {
    const url = new URL(baseUrl);
    url.searchParams.set('page', String(pageNumber));
    return url.toString();
}

// Waits for the page to go quiet, and gives a Cloudflare check a chance to
// finish by itself before anything is read.
async function settle(page: Page): Promise<string> {
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    let title = await page.title().catch(() => '');
    for (let i = 0; i < 15 && title.toLowerCase().includes('just a moment'); i++) {
        await page.waitForTimeout(2_000);
        title = await page.title().catch(() => '');
    }
    return title;
}

function isBlockedTitle(title: string): boolean {
    const lower = title.toLowerCase();
    return lower.includes('attention required') || lower.includes('just a moment') || lower.includes('cloudflare');
}

async function launch(authState: unknown, useResidential: boolean): Promise<Launched> {
    let proxy: { server: string; username?: string; password?: string } | undefined;

    if (useResidential) {
        const config = await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'], countryCode: 'US' });
        if (!config) {
            throw new Error('Residential proxy is not available on this account.');
        }
        const proxyUrl = await config.newUrl(`bs${Math.floor(Math.random() * 1_000_000)}`);
        if (!proxyUrl) {
            throw new Error('Could not get a residential proxy address.');
        }
        const parsed = new URL(proxyUrl);
        proxy = {
            server: `${parsed.protocol}//${parsed.host}`,
            username: decodeURIComponent(parsed.username),
            password: decodeURIComponent(parsed.password),
        };
        console.log('Using a residential proxy address for this session.');
    }

    const browser = await chromium.launch({
        headless: true,
        proxy,
        args: ['--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
        storageState: authState as any,
        viewport: { width: 1920, height: 1080 },
        userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        locale: 'en-US',
        extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });

    // Only text and links are needed, so skip images, video, fonts and trackers.
    // This keeps the residential proxy data use as low as possible.
    await context.route('**/*', async (route) => {
        const request = route.request();
        const type = request.resourceType();
        const url = request.url();
        const isTracker = BLOCKED_HOSTS.some((host) => url.includes(host));

        if (type === 'image' || type === 'media' || type === 'font' || isTracker) {
            await route.abort();
        } else {
            await route.continue();
        }
    });

    return { browser, context };
}

async function extractPeopleFromCurrentPage(page: Page, pageNumber: number): Promise<Person[]> {
    console.log(`FINAL URL: ${page.url()}`);
    const pageTitle = await page.title().catch(() => '');
    console.log(`TITLE: ${pageTitle}`);

    if (isBlockedTitle(pageTitle)) {
        throw new Error('Blocked by Cloudflare while loading this page.');
    }

    const links = page.locator('a[href*="/talent/"]');
    const count = await links.count();
    console.log(`TALENT LINKS FOUND ON PAGE ${pageNumber}: ${count}`);

    const people: Person[] = [];
    const seenOnPage = new Set<string>();

    for (let i = 0; i < count; i++) {
        const link = links.nth(i);
        const href = await link.getAttribute('href').catch(() => null);

        if (!href) continue;
        if (href.includes('profile_type=') || href.includes('skill_groups=')) continue;
        if (href.includes('/find-talent/') || href.includes('/talent-database') || href.includes('/post-a-job')) continue;

        const strippedPath = new URL(href, 'https://www.backstage.com').pathname.replace(/\/+$/, '');
        if (strippedPath === '/talent') continue;

        const profileUrl = new URL(href, page.url()).toString().split('?')[0];
        if (seenOnPage.has(profileUrl)) continue;

        const name = normalizeText(await link.innerText().catch(() => ''));
        if (!name) continue;

        seenOnPage.add(profileUrl);
        people.push({ profileUrl, name, discoveryPage: pageNumber });
    }

    console.log(`UNIQUE PEOPLE FOUND ON PAGE ${pageNumber}: ${people.length}`);
    return people;
}

async function extractContactLinks(page: Page): Promise<string[]> {
    const heading = page.locator('text=/^Websites\\s*\\/?\\s*Social Media$/i').first();
    const headingCount = await heading.count().catch(() => 0);

    if (headingCount === 0) return [];

    const container = heading.locator('xpath=following-sibling::*[1]');
    const containerCount = await container.count().catch(() => 0);
    const scope = containerCount > 0 ? container : heading.locator('xpath=..');

    const links = scope.locator('a[href]');
    const count = await links.count().catch(() => 0);
    const found: string[] = [];

    for (let i = 0; i < count; i++) {
        const href = await links.nth(i).getAttribute('href').catch(() => null);
        if (href && !found.includes(href)) found.push(href);
    }

    return found;
}

async function processProfile(page: Page, person: Person): Promise<boolean> {
    console.log('\n------------------------------');
    console.log(`PROCESSING: ${person.name}`);

    try {
        await page.goto(person.profileUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });
        const title = await settle(page);
        await pause(page, 3_000, 6_000);

        console.log(`PROFILE URL: ${page.url()}`);

        if (isBlockedTitle(title)) {
            throw new Error('Blocked by Cloudflare while loading this profile.');
        }

        const contactLinks = await extractContactLinks(page);
        console.log(`CONTACT LINKS FOUND: ${contactLinks.length}`);

        if (contactLinks.length === 0) {
            console.log('No contact links found. Nothing pushed to dataset.');
            return false;
        }

        await Actor.pushData({
            profileUrl: person.profileUrl,
            name: person.name,
            contactLinks,
            discoveryPage: person.discoveryPage,
        });
        console.log(`SAVED: ${person.name} (${contactLinks.length} link(s))`);
        return true;
    } catch (error) {
        console.error(`ERROR PROCESSING ${person.name}: ${errorMessage(error)}`);
        return false;
    }
}

await Actor.init();

let browser: Browser | null = null;
let context: BrowserContext | null = null;

try {
    const input = (await Actor.getInput()) as Input | null;

    if (!input || !input.startUrl) {
        throw new Error('startUrl is required.');
    }

    const startUrl = input.startUrl.trim();
    const authState = parseAuthState(input.authState);
    const maxPages = Math.max(0, Number(input.maxPages ?? 0));
    const maxProfiles = Math.max(0, Number(input.maxProfiles ?? 0));
    const useResidential = input.useResidentialProxy !== false;

    const state = await loadState();
    const seen = new Set(state.seenProfileUrls);

    console.log('==============================');
    console.log('BACKSTAGE TALENT SCRAPER');
    console.log('==============================');
    console.log(`Resuming from page: ${state.cursor}`);
    console.log(`Maximum pages this run: ${maxPages === 0 ? 'UNLIMITED' : maxPages}`);
    console.log(`Maximum profiles this run: ${maxProfiles === 0 ? 'UNLIMITED' : maxProfiles}`);
    console.log(`Residential proxy: ${useResidential ? 'ON' : 'OFF'}`);
    console.log(`Already known profiles: ${seen.size}`);

    let listPage: Page;
    let profilePage: Page;

    async function start(): Promise<void> {
        const launched = await launch(authState, useResidential);
        browser = launched.browser;
        context = launched.context;
        listPage = await context.newPage();
        profilePage = await context.newPage();
    }

    async function stop(): Promise<void> {
        if (context) await (context as BrowserContext).close().catch(() => undefined);
        if (browser) await (browser as Browser).close().catch(() => undefined);
    }

    async function discover(pageNum: number): Promise<Person[]> {
        console.log('\n==============================');
        console.log(`OPENING TALENT PAGE ${pageNum}`);
        console.log('==============================');

        await listPage.goto(buildPageUrl(startUrl, pageNum), {
            waitUntil: 'domcontentloaded',
            timeout: NAVIGATION_TIMEOUT,
        });
        const title = await settle(listPage);
        await pause(listPage, 3_000, 6_000);

        if (title.toLowerCase().includes('log in') || title.toLowerCase().includes('sign in')) {
            throw new Error('Backstage session appears to be unauthenticated or expired.');
        }

        return extractPeopleFromCurrentPage(listPage, pageNum);
    }

    async function discoverWithRecovery(pageNum: number): Promise<Person[]> {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                return await discover(pageNum);
            } catch (error) {
                const message = errorMessage(error);
                const recoverable =
                    message.includes('Timeout') || message.includes('ERR_') || message.includes('Cloudflare');

                if (!recoverable || attempt === 3) throw error;

                console.log(`Attempt ${attempt} failed (${message}). Restarting with a fresh address.`);
                await stop();
                await start();
            }
        }
        return [];
    }

    await start();

    let pageNumber = state.cursor;
    let emptyPages = 0;
    const MAX_EMPTY_PAGES = 3;
    let totalDiscovered = 0;
    let totalProcessed = 0;
    let totalSaved = 0;
    let pagesThisRun = 0;

    while (maxPages === 0 || pagesThisRun < maxPages) {
        let people = await discoverWithRecovery(pageNumber);

        if (people.length === 0) {
            console.log(`Page ${pageNumber} came back empty, waiting before trusting that.`);
            await pause(listPage, 15_000, 25_000);
            people = await discoverWithRecovery(pageNumber);
        }

        if (people.length === 0) {
            emptyPages++;
            console.log(`Page ${pageNumber} empty on retry too. Consecutive empty pages: ${emptyPages}/${MAX_EMPTY_PAGES}.`);
            if (emptyPages >= MAX_EMPTY_PAGES) {
                console.log('Treating this as the real end of the list.');
                break;
            }
            pageNumber++;
            await saveState({ cursor: pageNumber, seenProfileUrls: Array.from(seen) });
            continue;
        }

        emptyPages = 0;
        totalDiscovered += people.length;
        let limitHit = false;

        for (const person of people) {
            if (seen.has(person.profileUrl)) continue;

            if (maxProfiles > 0 && totalProcessed >= maxProfiles) {
                limitHit = true;
                break;
            }

            seen.add(person.profileUrl);
            totalProcessed++;

            const saved = await processProfile(profilePage, person);
            if (saved) totalSaved++;

            console.log(`PROGRESS: processed=${totalProcessed}, saved=${totalSaved}`);
            await pause(profilePage, 6_000, 14_000);
        }

        if (limitHit || (maxProfiles > 0 && totalProcessed >= maxProfiles)) {
            await saveState({ cursor: pageNumber, seenProfileUrls: Array.from(seen) });
            console.log(`Reached configured profile limit: ${maxProfiles}.`);
            break;
        }

        pageNumber++;
        pagesThisRun++;
        await saveState({ cursor: pageNumber, seenProfileUrls: Array.from(seen) });
    }

    console.log('\n==============================');
    console.log('SCRAPER FINISHED');
    console.log('==============================');
    console.log(`Pages processed this run: ${pagesThisRun}`);
    console.log(`People discovered: ${totalDiscovered}`);
    console.log(`Profiles processed: ${totalProcessed}`);
    console.log(`Records saved: ${totalSaved}`);
} catch (error) {
    console.error(`FATAL ACTOR ERROR: ${errorMessage(error)}`);
    throw error;
} finally {
    if (context) await (context as BrowserContext).close().catch(() => undefined);
    if (browser) await (browser as Browser).close().catch(() => undefined);
    await Actor.exit();
}
