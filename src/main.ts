import { Actor } from 'apify';
import {
    chromium,
    type Browser,
    type BrowserContext,
    type Page,
} from 'playwright';

interface Input {
    startUrl: string;
    authState?: unknown;
    maxPages?: number;
    maxProfiles?: number;
}

interface Person {
    profileUrl: string;
    name: string;
    discoveryPage: number;
}

interface PersonRecord {
    profileUrl: string;
    name: string;
    contactLinks: string[];
    discoveryPage: number;
}

interface RunState {
    cursor: number;
    seenProfileUrls: string[];
}

const STATE_KEY = 'BACKSTAGE_STATE';
const STATE_STORE_NAME = 'backstage-progress';
const NAVIGATION_TIMEOUT = 120_000;

// Paste your own exported Playwright storage state JSON here between the
// backticks. Once filled in, nobody running this actor needs to supply
// their own session, it will be used automatically unless the authState
// input field is filled in for a specific run.
const EMBEDDED_AUTH_STATE_JSON = `PASTE_YOUR_AUTH_STATE_JSON_HERE`;

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

function normalizeText(value: string | null | undefined): string {
    return (value ?? '').replace(/\s+/g, ' ').trim();
}

function randomJitterMs(baseMs: number, spreadMs: number): number {
    return baseMs + Math.floor(Math.random() * spreadMs);
}

function resolveAuthState(inputAuthState: unknown): unknown {
    if (
        inputAuthState !== undefined &&
        inputAuthState !== null &&
        inputAuthState !== ''
    ) {
        return parseAuthState(inputAuthState);
    }

    const embedded = EMBEDDED_AUTH_STATE_JSON.trim();

    if (!embedded || embedded === 'PASTE_YOUR_AUTH_STATE_JSON_HERE') {
        throw new Error(
            'No authState was supplied in the input, and no session has been ' +
                'embedded in the source yet. Either fill in the authState input ' +
                'field for this run, or paste a real session into ' +
                'EMBEDDED_AUTH_STATE_JSON in main.ts.',
        );
    }

    return parseAuthState(embedded);
}

function parseAuthState(value: unknown): unknown {
    if (typeof value !== 'string') return value;

    const trimmed = value.trim();

    if (!trimmed) {
        throw new Error('authState is empty.');
    }

    try {
        return JSON.parse(trimmed);
    } catch (error) {
        throw new Error(`Could not parse authState JSON: ${errorMessage(error)}`);
    }
}

async function loadState(): Promise<RunState> {
    const store = await Actor.openKeyValueStore(STATE_STORE_NAME);
    const saved = await store.getValue<RunState>(STATE_KEY);

    if (saved) {
        return saved;
    }

    return { cursor: 1, seenProfileUrls: [] };
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

async function verifyAuthentication(page: Page, startUrl: string): Promise<void> {
    console.log('Checking Backstage authentication...');

    await page.goto(startUrl, {
        waitUntil: 'domcontentloaded',
        timeout: NAVIGATION_TIMEOUT,
    });

    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500);

    const title = await page.title().catch(() => '');
    console.log(`AUTH URL: ${page.url()}`);
    console.log(`AUTH TITLE: ${title}`);

    const lowerTitle = title.toLowerCase();

    if (lowerTitle.includes('attention required') || lowerTitle.includes('just a moment') || lowerTitle.includes('cloudflare')) {
        throw new Error('Blocked by Cloudflare before the page could load.');
    }

    if (lowerTitle.includes('log in') || lowerTitle.includes('sign in')) {
        throw new Error('Backstage session appears to be unauthenticated or expired.');
    }

    console.log('Backstage authentication check passed.');
}

async function discoverPeople(
    page: Page,
    pageNumber: number,
    baseUrl: string,
): Promise<Person[]> {
    const url = buildPageUrl(baseUrl, pageNumber);

    console.log('\n==============================');
    console.log(`OPENING TALENT PAGE ${pageNumber}`);
    console.log('==============================');

    await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: NAVIGATION_TIMEOUT,
    });

    console.log('Waiting for Backstage results...');
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(randomJitterMs(1_500, 1_500));

    console.log(`FINAL URL: ${page.url()}`);
    const pageTitle = await page.title().catch(() => '');
    console.log(`TITLE: ${pageTitle}`);

    const lowerTitle = pageTitle.toLowerCase();
    if (lowerTitle.includes('attention required') || lowerTitle.includes('just a moment') || lowerTitle.includes('cloudflare')) {
        throw new Error('Blocked by Cloudflare while loading this page.');
    }

    // Each talent card links to that person's own profile page. Cards live
    // under the browse/listing path, so any link into that same area that
    // is not just the bare browse URL itself is treated as a profile link.
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

async function captureDiagnosticsOnce(page: Page, tag: string): Promise<void> {
    try {
        const html = await page.content();
        await Actor.setValue(`diagnostic-html-${tag}`, html, { contentType: 'text/html' });
        const screenshot = await page.screenshot({ fullPage: true });
        await Actor.setValue(`diagnostic-screenshot-${tag}`, screenshot, { contentType: 'image/png' });
        console.log(`DIAGNOSTIC CAPTURED for ${tag}, html length=${html.length}`);
    } catch (error) {
        console.log(`DIAGNOSTIC CAPTURE FAILED for ${tag}: ${errorMessage(error)}`);
    }
}

// The Websites/Social Media block sits under its own heading on the
// profile page. Rather than guess exact class names, this finds the small
// heading by its text and reads whatever links sit in the section right
// after it, stopping if it runs into the next differently labelled block.
async function extractContactLinks(page: Page): Promise<string[]> {
    const heading = page.locator('text=/^Websites\\s*\\/?\\s*Social Media$/i').first();
    const headingCount = await heading.count().catch(() => 0);

    if (headingCount === 0) {
        return [];
    }

    const container = heading.locator('xpath=following-sibling::*[1]');
    const containerCount = await container.count().catch(() => 0);

    const scope = containerCount > 0 ? container : heading.locator('xpath=..');

    const links = scope.locator('a[href]');
    const count = await links.count().catch(() => 0);

    const found: string[] = [];

    for (let i = 0; i < count; i++) {
        const href = await links.nth(i).getAttribute('href').catch(() => null);
        if (href && !found.includes(href)) {
            found.push(href);
        }
    }

    return found;
}

async function processProfile(page: Page, person: Person): Promise<PersonRecord | null> {
    console.log('\n------------------------------');
    console.log(`PROCESSING: ${person.name}`);
    console.log('------------------------------');

    try {
        await page.goto(person.profileUrl, {
            waitUntil: 'domcontentloaded',
            timeout: NAVIGATION_TIMEOUT,
        });

        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
        await page.waitForTimeout(randomJitterMs(1_200, 1_500));

        console.log(`PROFILE URL: ${page.url()}`);

        const title = await page.title().catch(() => '');
        if (title.toLowerCase().includes('attention required') || title.toLowerCase().includes('just a moment')) {
            throw new Error('Blocked by Cloudflare while loading this profile.');
        }

        const contactLinks = await extractContactLinks(page);

        console.log(`CONTACT LINKS FOUND: ${contactLinks.length}`);

        if (contactLinks.length === 0) {
            await captureDiagnosticsOnce(page, 'no-contact-links');
            console.log('No contact links found. Nothing pushed to dataset.');
            return null;
        }

        const record: PersonRecord = {
            profileUrl: person.profileUrl,
            name: person.name,
            contactLinks,
            discoveryPage: person.discoveryPage,
        };

        await Actor.pushData(record);
        console.log(`SAVED: ${person.name} (${contactLinks.length} link(s))`);

        return record;
    } catch (error) {
        console.error(`ERROR PROCESSING ${person.name}: ${errorMessage(error)}`);
        return null;
    }
}

await Actor.init();

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let listPage: Page;

try {
    const input = (await Actor.getInput()) as Input | null;

    if (!input || !input.startUrl) {
        throw new Error('startUrl is required.');
    }

    const startUrl = input.startUrl.trim();
    const authState = resolveAuthState(input.authState);
    const maxPages = Math.max(0, Number(input.maxPages ?? 0));
    const maxProfiles = Math.max(0, Number(input.maxProfiles ?? 0));

    const state = await loadState();
    const seen = new Set(state.seenProfileUrls);

    console.log('==============================');
    console.log('BACKSTAGE TALENT SCRAPER');
    console.log('==============================');
    console.log(`Resuming from page: ${state.cursor}`);
    console.log(`Maximum pages this run: ${maxPages === 0 ? 'UNLIMITED' : maxPages}`);
    console.log(`Maximum profiles this run: ${maxProfiles === 0 ? 'UNLIMITED' : maxProfiles}`);
    console.log(`Already known profiles: ${seen.size}`);

    async function buildProxyForNewSession(): Promise<
        { server: string; username?: string; password?: string } | undefined
    > {
        try {
            const proxyConfiguration = await Actor.createProxyConfiguration();
            if (!proxyConfiguration) return undefined;

            const sessionId = `backstage_${Math.floor(Math.random() * 1_000_000)}`;
            const proxyUrl = await proxyConfiguration.newUrl(sessionId);
            if (!proxyUrl) return undefined;

            const parsed = new URL(proxyUrl);
            return {
                server: `${parsed.protocol}//${parsed.host}`,
                username: decodeURIComponent(parsed.username),
                password: decodeURIComponent(parsed.password),
            };
        } catch (error) {
            console.log(`Could not set up Apify proxy, continuing without it: ${errorMessage(error)}`);
            return undefined;
        }
    }

    async function launchBrowserAndContext(): Promise<{ browser: Browser; context: BrowserContext }> {
        const launchProxy = await buildProxyForNewSession();

        if (launchProxy) {
            console.log('Using a fresh Apify proxy address for this attempt.');
        }

        const newBrowser = await chromium.launch({
            headless: true,
            proxy: launchProxy,
            args: ['--disable-blink-features=AutomationControlled'],
        });

        const newContext = await newBrowser.newContext({
            storageState: authState as any,
            viewport: { width: 1920, height: 1080 },
            userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            locale: 'en-US',
            extraHTTPHeaders: {
                'Accept-Language': 'en-US,en;q=0.9',
            },
        });

        return { browser: newBrowser, context: newContext };
    }

    const MAX_LAUNCH_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_LAUNCH_ATTEMPTS; attempt++) {
        console.log(`\nLaunch attempt ${attempt} of ${MAX_LAUNCH_ATTEMPTS}...`);

        const launched = await launchBrowserAndContext();
        browser = launched.browser;
        context = launched.context;

        try {
            const probePage = await context.newPage();
            console.log('Checking Backstage authentication with the real first page load...');
            await probePage.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });
            await probePage.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
            await probePage.waitForTimeout(1_500);

            const probeTitle = await probePage.title().catch(() => '');
            console.log(`AUTH URL: ${probePage.url()}`);
            console.log(`AUTH TITLE: ${probeTitle}`);

            const lowerProbeTitle = probeTitle.toLowerCase();
            if (lowerProbeTitle.includes('attention required') || lowerProbeTitle.includes('just a moment') || lowerProbeTitle.includes('cloudflare')) {
                await captureDiagnosticsOnce(probePage, `auth-attempt-${attempt}`);
                await probePage.close().catch(() => undefined);
                throw new Error('Blocked by Cloudflare on the first page load.');
            }

            if (lowerProbeTitle.includes('log in') || lowerProbeTitle.includes('sign in')) {
                await probePage.close().catch(() => undefined);
                throw new Error('Backstage session appears to be unauthenticated or expired.');
            }

            console.log('Backstage authentication check passed.');
            // Reuse this exact same page as the first real listing page,
            // instead of closing it and opening a fresh one to hit the
            // identical URL again a moment later.
            listPage = probePage;
            break;
        } catch (error) {
            const isConnectionIssue =
                errorMessage(error).includes('Timeout') ||
                errorMessage(error).includes('ERR_TIMED_OUT') ||
                errorMessage(error).includes('ERR_CONNECTION') ||
                errorMessage(error).includes('Cloudflare');

            if (isConnectionIssue && attempt < MAX_LAUNCH_ATTEMPTS) {
                console.log(`Retrying with a fresh address: ${errorMessage(error)}`);
                await launched.context.close().catch(() => undefined);
                await launched.browser.close().catch(() => undefined);
                continue;
            }

            throw error;
        }
    }

    if (!context || !browser) {
        throw new Error('Browser context was not established after all launch attempts.');
    }

    let profilePage = await context.newPage();

    async function relaunchWithFreshProxy(): Promise<void> {
        console.log('Relaunching the browser with a fresh proxy address after a connection level failure.');
        await context!.close().catch(() => undefined);
        await browser!.close().catch(() => undefined);

        const relaunched = await launchBrowserAndContext();
        browser = relaunched.browser;
        context = relaunched.context;

        listPage = await context.newPage();
        profilePage = await context.newPage();
    }

    async function discoverPeopleWithRecovery(pageNum: number): Promise<Person[]> {
        try {
            return await discoverPeople(listPage, pageNum, startUrl);
        } catch (error) {
            const isConnectionIssue =
                errorMessage(error).includes('Timeout') ||
                errorMessage(error).includes('ERR_TIMED_OUT') ||
                errorMessage(error).includes('ERR_CONNECTION');

            if (!isConnectionIssue) throw error;

            await relaunchWithFreshProxy();
            return discoverPeople(listPage, pageNum, startUrl);
        }
    }

    let pageNumber = state.cursor;
    let consecutiveEmptyPages = 0;
    const MAX_CONSECUTIVE_EMPTY_PAGES = 3;

    let totalDiscovered = 0;
    let totalProcessed = 0;
    let totalSaved = 0;
    let pagesThisRun = 0;

    while (maxPages === 0 || pagesThisRun < maxPages) {
        let people = await discoverPeopleWithRecovery(pageNumber);

        if (people.length === 0) {
            console.log(`Page ${pageNumber} came back empty, retrying once before trusting that.`);
            await listPage.waitForTimeout(randomJitterMs(2_000, 2_000));
            people = await discoverPeopleWithRecovery(pageNumber);
        }

        if (people.length === 0) {
            consecutiveEmptyPages++;
            console.log(`Page ${pageNumber} empty on retry too. Consecutive empty pages: ${consecutiveEmptyPages}/${MAX_CONSECUTIVE_EMPTY_PAGES}.`);

            if (consecutiveEmptyPages >= MAX_CONSECUTIVE_EMPTY_PAGES) {
                console.log('Treating this as the real end of the list.');
                break;
            }

            pageNumber++;
            await saveState({ cursor: pageNumber, seenProfileUrls: Array.from(seen) });
            continue;
        }

        consecutiveEmptyPages = 0;
        totalDiscovered += people.length;

        for (const person of people) {
            if (seen.has(person.profileUrl)) continue;

            if (maxProfiles > 0 && totalProcessed >= maxProfiles) break;

            seen.add(person.profileUrl);
            totalProcessed++;

            const saved = await processProfile(profilePage, person);
            if (saved) totalSaved++;

            console.log(`PROGRESS: processed=${totalProcessed}, saved=${totalSaved}`);

            await profilePage.waitForTimeout(randomJitterMs(800, 2_200));
        }

        pageNumber++;
        pagesThisRun++;

        await saveState({ cursor: pageNumber, seenProfileUrls: Array.from(seen) });

        if (maxProfiles > 0 && totalProcessed >= maxProfiles) {
            console.log(`Reached configured profile limit: ${maxProfiles}.`);
            break;
        }
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
    if (context) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    await Actor.exit();
}
