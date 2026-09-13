import { Actor } from 'apify';
import {
    chromium,
    type Browser,
    type BrowserContext,
    type Locator,
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
const EMBEDDED_AUTH_STATE_JSON = `{
  "cookies": [
    {
      "name": "_scid_r",
      "value": "eOdD5QuUb5za3j3WH_zclFZ8D32u9Ti02uTp1A",
      "domain": ".backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": false,
      "sameSite": "Lax",
      "expires": 1823353490
    },
    {
      "name": "__mmapiwsid",
      "value": "01a09623-bec6-7fe6-9df5-f7436442d2c8:05fd652a0a55448f87dc687b88449255ab6cf8e3",
      "domain": ".backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": true,
      "sameSite": "None",
      "expires": 1823785518.65841
    },
    {
      "name": "intercom-device-id-ldwgq3j7",
      "value": "b1c6052e-1144-4760-8166-77b7cea072c8",
      "domain": ".backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": false,
      "sameSite": "Lax",
      "expires": 1812555519
    },
    {
      "name": "_hjSession_773252",
      "value": "eyJpZCI6IjQyNTgyM2JhLTZhZmYtNDg1Yi1iNzlhLTNmNzYxOWVmMTI4ZCIsImMiOjE3ODkyMjUzMDU3MzYsInMiOjAsInIiOjAsInNiIjowLCJzciI6MCwic2UiOjAsImZzIjoxLCJzcCI6MH0=",
      "domain": ".backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": true,
      "sameSite": "None",
      "expires": 1789227322
    },
    {
      "name": "ttcsid_C4JAIPD1KC6QQ9D0HVB0",
      "value": "1789225301239::u22MZ4Z6oIErVcuZvRrV.1.1789225495547.1",
      "domain": ".backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": false,
      "sameSite": "Lax",
      "expires": 1822921495
    },
    {
      "name": "_ju_pn",
      "value": "3",
      "domain": ".backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": false,
      "sameSite": "Lax",
      "expires": 1789227292
    },
    {
      "name": "intercom-session-ldwgq3j7",
      "value": "RjA0K213azBNY3M1dkMxRDMrT290d3hPUlBoS2E5bm1YSDdCaWFpVFBGNEc0N3QwMW9vZjUvUkRTQXdLemZYYWJwSDdhaHd1OUx5ZUttcXU2Smorc0FyZUxTdmRFYktBRUVxalVjSCtrYUFqdDE5UGpsdzFMZ1NVZVQ4bmRRemNqNm4yMlBiS3JPSXNZcVNGVWVTUlYwUG13SzN0QVRHdFdtZHZnVW1xemtTTjVGbzRWMlhERVZEWVY1QTA4VG5lS3NiOGpWQnk4aU9tV0luM1NUTHpOQT09LS0rQndTcFZzZkhHOVNDVXMzcnZ0bjdRPT0=--820f6fa1153ae9e72ef997b6e7bcbae355949da4",
      "domain": ".backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": false,
      "sameSite": "Lax",
      "expires": 1789830317
    },
    {
      "name": "_ju_dm",
      "value": "cookie",
      "domain": ".backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": false,
      "sameSite": "Lax",
      "expires": 1789311890
    },
    {
      "name": "analytics_session_id",
      "value": "1789225273250",
      "domain": ".backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": false,
      "sameSite": "Lax",
      "expires": 1820761495
    },
    {
      "name": "__stripe_mid",
      "value": "82ff1d30-e47e-49f2-9bdc-6c50ef6cc50dc19307",
      "domain": ".www.backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": true,
      "sameSite": "Strict",
      "expires": 1820761496
    },
    {
      "name": "_scid",
      "value": "bmdD5QuUb5za3j3WH_zclFZ8D32u9Ti0",
      "domain": ".backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": false,
      "sameSite": "Lax",
      "expires": 1823353305
    },
    {
      "name": "bslng",
      "value": "en",
      "domain": "www.backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": false,
      "sameSite": "Strict",
      "expires": -1
    },
    {
      "name": "OptanonConsent",
      "value": "isGpcEnabled=0&datestamp=Sat+Sep+12+2026+16%3A04%3A50+GMT%2B0100+(West+Africa+Time)&version=202511.1.0&browserGpcFlag=0&isIABGlobal=false&hosts=&consentId=a38572af-f8fb-411e-9804-72f542b23fe8&interactionCount=1&isAnonUser=1&landingPath=NotLandingPage&groups=C0001%3A1%2CC0003%3A1%2CC0002%3A1%2CC0004%3A1&AwaitingReconsent=false",
      "domain": ".www.backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": false,
      "sameSite": "Lax",
      "expires": 1820761490
    },
    {
      "name": "__cf_bm",
      "value": "WDev43XhXm1.eHOSdzhNMXccM6TrPhDowT7xqw4RnNA-1789225420.3651102-1.0.1.1-.4_vV0VwMHJWW5BQrRl8Rq9cuiMABTxVw1a4cPA4ScZVFxB3eP7jwlsFggJIZpLRk0832Jl5OP1R7NVBfmPBVnpklOuNbh8_RX2DHRVc3ZfFIx0qy3OPUP2Md4nIByKT",
      "domain": ".backstage.com",
      "path": "/",
      "httpOnly": true,
      "secure": true,
      "sameSite": "None",
      "expires": 1789227221.999441
    },
    {
      "name": "__spdt",
      "value": "ca4baeb3e8cb45d2aec8c4449335842c",
      "domain": "www.backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": false,
      "sameSite": "Strict",
      "expires": 1820761299
    },
    {
      "name": "__stripe_sid",
      "value": "1cf7a322-c233-4149-810f-662ed9903c9c6e1ae5",
      "domain": ".www.backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": true,
      "sameSite": "Strict",
      "expires": 1789227296
    },
    {
      "name": "_fbp",
      "value": "fb.1.1789225274982.438335685976460012",
      "domain": ".backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": false,
      "sameSite": "Lax",
      "expires": 1797001496
    },
    {
      "name": "_hjSessionUser_773252",
      "value": "eyJpZCI6IjJlMDBmZTI2LTAwYzYtNTJjNi05MGRhLTVmZjU0N2JiMGZjMSIsImNyZWF0ZWQiOjE3ODkyMjUzMDU3MzMsImV4aXN0aW5nIjp0cnVlfQ==",
      "domain": ".backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": true,
      "sameSite": "None",
      "expires": 1820761491
    },
    {
      "name": "_ju_dc",
      "value": "df66d138-aeba-11f1-91c1-fd2d82335b97",
      "domain": ".backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": false,
      "sameSite": "Lax",
      "expires": 1820761494
    },
    {
      "name": "_ju_dn",
      "value": "1",
      "domain": ".backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": false,
      "sameSite": "Lax",
      "expires": 1791817490
    },
    {
      "name": "_ju_v",
      "value": "4.1_6.24",
      "domain": "www.backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": true,
      "sameSite": "Lax",
      "expires": 1789227099
    },
    {
      "name": "_rdt_uuid",
      "value": "1789225305751.f724c46b-bbe1-476c-885b-3c5d561380b5",
      "domain": ".backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": true,
      "sameSite": "Strict",
      "expires": 1797001491
    },
    {
      "name": "_sctr",
      "value": "1%7C1789167600000",
      "domain": ".backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": false,
      "sameSite": "Lax",
      "expires": 1823353310
    },
    {
      "name": "_tt_enable_cookie",
      "value": "1",
      "domain": ".backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": false,
      "sameSite": "Lax",
      "expires": 1822921491
    },
    {
      "name": "_ttp",
      "value": "01M2B26X7CY01P3EX5C2JQVFAK_.tt.1.1789225301229",
      "domain": ".backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": false,
      "sameSite": "Lax",
      "expires": 1822921491
    },
    {
      "name": "ajs_anonymous_id",
      "value": "6130b115-b260-4bd4-be3e-78020d346572",
      "domain": "www.backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": true,
      "sameSite": "Lax",
      "expires": -1
    },
    {
      "name": "ajs_anonymous_id",
      "value": "6130b115-b260-4bd4-be3e-78020d346572",
      "domain": ".backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": false,
      "sameSite": "Lax",
      "expires": 1820761495
    },
    {
      "name": "ajs_user_id",
      "value": "16704647",
      "domain": ".backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": false,
      "sameSite": "Lax",
      "expires": 1820761495
    },
    {
      "name": "analytics_session_id.last_access",
      "value": "1789225495643",
      "domain": ".backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": false,
      "sameSite": "Lax",
      "expires": 1820761495
    },
    {
      "name": "bs_analytics_universal_cache",
      "value": "{%22landed_on_slug%22:%22/%22}",
      "domain": "www.backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": false,
      "sameSite": "Lax",
      "expires": -1
    },
    {
      "name": "csrftoken",
      "value": "ZgeTkbARPQnS3dN0ec1jw2rWdu0EzLRA",
      "domain": "www.backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": true,
      "sameSite": "Lax",
      "expires": 1820675089.29694
    },
    {
      "name": "intercom-id-ldwgq3j7",
      "value": "925d5f59-96df-4285-b845-855bf144daad",
      "domain": ".backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": false,
      "sameSite": "Lax",
      "expires": 1812555316
    },
    {
      "name": "sessionid",
      "value": "iu8tbzl07wu4a4kxd70ysrzh0dsgzbr1",
      "domain": "www.backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": true,
      "sameSite": "Lax",
      "expires": 1789830224.546473
    },
    {
      "name": "ttcsid",
      "value": "1789225301241::jCwQmrkJqZs9dKelvh7P.1.1789225495547.0::1.187409.190082::194242.3.943.21::0.0.0",
      "domain": ".backstage.com",
      "path": "/",
      "httpOnly": false,
      "secure": false,
      "sameSite": "Lax",
      "expires": 1822921495
    }
  ],
  "origins": []
}`;

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

async function isVisible(locator: Locator): Promise<boolean> {
    return locator.isVisible().catch(() => false);
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
    console.log(`TITLE: ${await page.title().catch(() => '')}`);

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

        const authPage = await context.newPage();

        try {
            await verifyAuthentication(authPage, buildPageUrl(startUrl, state.cursor));
            await authPage.close().catch(() => undefined);
            break;
        } catch (error) {
            await captureDiagnosticsOnce(authPage, `auth-attempt-${attempt}`);
            await authPage.close().catch(() => undefined);

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

    let listPage = await context.newPage();
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
