/**
 * ClawHub Service
 * Direct HTTP implementation for skill management — replaces CLI subprocess spawning
 * for better timeout control, proxy support (via Electron net.fetch), and performance.
 */
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { getOpenClawConfigDir, ensureDir } from '../utils/paths';

// ─── Constants ───────────────────────────────────────────────────────────────

const REGISTRY = 'https://clawhub.ai';

/** Timeout for API metadata requests (search, explore, resolve) */
const API_TIMEOUT_MS = 30_000;

/** Timeout for zip download — generous to handle large skills on slow networks */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Max retries for transient failures (5xx, 429) */
const MAX_RETRIES = 3;

/** Base delay for exponential backoff on retries (ms) */
const RETRY_BASE_DELAY_MS = 2_000;

/** Base delay for download retries — longer since rate limits need more cooldown */
const DOWNLOAD_RETRY_BASE_DELAY_MS = 3_000;

/** API route constants (mirrors clawhub schema/routes) */
const ApiRoutes = {
    search: '/api/v1/search',
    resolve: '/api/v1/resolve',
    download: '/api/v1/download',
    skills: '/api/v1/skills',
} as const;

// ─── Auth Token ──────────────────────────────────────────────────────────────

/**
 * Read the optional auth token from clawhub's global config.
 * Config location follows the same logic as the clawhub CLI:
 *   macOS: ~/Library/Application Support/clawhub/config.json
 *   Linux: ~/.config/clawhub/config.json (or $XDG_CONFIG_HOME)
 *   Windows: %APPDATA%/clawhub/config.json
 */
async function getOptionalAuthToken(): Promise<string | undefined> {
    const configPaths = getClawHubConfigPaths();
    for (const p of configPaths) {
        try {
            const raw = await fs.promises.readFile(p, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed?.token && typeof parsed.token === 'string') {
                return parsed.token;
            }
        } catch {
            // try next
        }
    }
    return undefined;
}

function getClawHubConfigPaths(): string[] {
    const home = homedir();
    const paths: string[] = [];

    if (process.platform === 'darwin') {
        paths.push(
            path.join(home, 'Library', 'Application Support', 'clawhub', 'config.json'),
            path.join(home, 'Library', 'Application Support', 'clawdhub', 'config.json'),
        );
    } else if (process.platform === 'win32') {
        const appData = process.env.APPDATA;
        if (appData) {
            paths.push(
                path.join(appData, 'clawhub', 'config.json'),
                path.join(appData, 'clawdhub', 'config.json'),
            );
        }
    }

    // XDG / fallback
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    paths.push(
        path.join(xdg, 'clawhub', 'config.json'),
        path.join(xdg, 'clawdhub', 'config.json'),
    );

    return paths;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ClawHubSearchParams {
    query: string;
    limit?: number;
}

export interface ClawHubInstallParams {
    slug: string;
    version?: string;
    force?: boolean;
}

export interface ClawHubUninstallParams {
    slug: string;
}

export interface ClawHubSkillResult {
    slug: string;
    name: string;
    description: string;
    version: string;
    author?: string;
    downloads?: number;
    stars?: number;
}

interface SearchApiResult {
    results: Array<{
        slug: string;
        displayName?: string;
        summary?: string;
        version?: string | null;
        score: number;
    }>;
}

interface SkillListApiResult {
    items: Array<{
        slug: string;
        displayName?: string;
        summary?: string;
        latestVersion?: { version: string };
        updatedAt: number;
    }>;
}

interface SkillDetailApiResult {
    slug: string;
    displayName?: string;
    summary?: string;
    latestVersion?: { version: string };
}

interface LockfileData {
    version: number;
    skills: Record<string, { version: string; installedAt: number }>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Proxy-aware fetch: uses `electron.net.fetch` when available so that
 * session.setProxy() settings are honored. Falls back to global fetch.
 */
async function electronFetch(
    input: string | URL,
    init?: RequestInit & { signal?: AbortSignal },
): Promise<Response> {
    if (process.versions.electron) {
        try {
            const { net } = await import('electron');
            return await net.fetch(input.toString(), init);
        } catch {
            // Fall through to global fetch
        }
    }
    return await fetch(input, init);
}

/**
 * Sleep with exponential backoff + jitter.
 * Respects Retry-After header if provided.
 */
async function backoff(attempt: number, baseMs: number, retryAfterHeader?: string | null): Promise<void> {
    let delayMs: number;

    // Prefer server-specified Retry-After (in seconds)
    if (retryAfterHeader) {
        const retryAfterSec = Number(retryAfterHeader);
        if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
            delayMs = retryAfterSec * 1000;
        } else {
            delayMs = baseMs * Math.pow(2, attempt);
        }
    } else {
        delayMs = baseMs * Math.pow(2, attempt);
    }

    // Add jitter (±20%)
    const jitter = delayMs * 0.2 * (Math.random() * 2 - 1);
    delayMs = Math.max(500, delayMs + jitter);

    console.log(`[clawhub] Retrying in ${Math.round(delayMs)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
    await new Promise(resolve => setTimeout(resolve, delayMs));
}

/**
 * Fetch JSON from the registry with timeout, retries, and proxy support.
 */
async function apiFetch<T>(
    urlStr: string,
    timeoutMs: number = API_TIMEOUT_MS,
    token?: string,
): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort('Timeout'), timeoutMs);

        try {
            const headers: Record<string, string> = { Accept: 'application/json' };
            if (token) headers.Authorization = `Bearer ${token}`;
            const response = await electronFetch(urlStr, {
                method: 'GET',
                headers,
                signal: controller.signal,
            });
            clearTimeout(timer);

            if (response.ok) {
                return (await response.json()) as T;
            }

            const text = await response.text().catch(() => '');
            console.warn(`[clawhub] API error: HTTP ${response.status} ${urlStr}`, text.slice(0, 200));

            // Retry on 429 / 5xx with backoff
            if (response.status === 429 || response.status >= 500) {
                lastError = new Error(text || `HTTP ${response.status}`);
                if (attempt < MAX_RETRIES) {
                    await backoff(attempt, RETRY_BASE_DELAY_MS, response.headers.get('retry-after'));
                }
                continue;
            }

            // Non-retryable error
            throw new Error(text || `HTTP ${response.status}`);
        } catch (err) {
            clearTimeout(timer);

            if (err instanceof Error && err.message === 'Timeout') {
                lastError = new Error(`Timeout after ${timeoutMs / 1000}s`);
                continue;
            }

            // AbortError from controller.abort
            const errMsg = err instanceof Error ? err.message : String(err);
            if (errMsg.includes('abort') || errMsg.includes('Timeout')) {
                lastError = new Error(`Timeout after ${timeoutMs / 1000}s`);
                continue;
            }

            throw err;
        }
    }

    throw lastError ?? new Error('Request failed');
}

/**
 * Download binary data from the registry with generous timeout.
 */
async function downloadBytes(
    urlStr: string,
    timeoutMs: number = DOWNLOAD_TIMEOUT_MS,
    token?: string,
): Promise<Uint8Array> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort('Timeout'), timeoutMs);

        try {
            const headers: Record<string, string> = {};
            if (token) headers.Authorization = `Bearer ${token}`;
            const response = await electronFetch(urlStr, {
                method: 'GET',
                headers,
                signal: controller.signal,
            });
            clearTimeout(timer);

            if (response.ok) {
                return new Uint8Array(await response.arrayBuffer());
            }

            const text = await response.text().catch(() => '');
            console.warn(`[clawhub] Download error: HTTP ${response.status} ${urlStr}`, text.slice(0, 200));
            if (response.status === 429 || response.status >= 500) {
                lastError = new Error(text || `HTTP ${response.status}`);
                if (attempt < MAX_RETRIES) {
                    await backoff(attempt, DOWNLOAD_RETRY_BASE_DELAY_MS, response.headers.get('retry-after'));
                }
                continue;
            }

            throw new Error(text || `HTTP ${response.status}`);
        } catch (err) {
            clearTimeout(timer);

            const errMsg = err instanceof Error ? err.message : String(err);
            if (errMsg.includes('abort') || errMsg.includes('Timeout')) {
                lastError = new Error(`Timeout after ${timeoutMs / 1000}s`);
                continue;
            }

            throw err;
        }
    }

    throw lastError ?? new Error('Download failed');
}

/**
 * Extract a zip buffer into a target directory using Node.js built-in zlib.
 * Parses the ZIP local file headers directly — no external dependency needed.
 */
async function extractZipToDir(zipBytes: Uint8Array, targetDir: string): Promise<void> {
    const { inflateRawSync } = await import('zlib');
    const buf = Buffer.from(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);

    await fs.promises.mkdir(targetDir, { recursive: true });

    let offset = 0;
    while (offset + 30 <= buf.length) {
        // Local file header signature = 0x04034b50
        const sig = buf.readUInt32LE(offset);
        if (sig !== 0x04034b50) break;

        const compressionMethod = buf.readUInt16LE(offset + 8);
        const compressedSize = buf.readUInt32LE(offset + 18);
        // offset + 22 = uncompressed size (unused, skip 4 bytes)
        const nameLen = buf.readUInt16LE(offset + 26);
        const extraLen = buf.readUInt16LE(offset + 28);

        const nameStart = offset + 30;
        const rawName = buf.toString('utf8', nameStart, nameStart + nameLen);
        const dataStart = nameStart + nameLen + extraLen;

        offset = dataStart + compressedSize;

        const safePath = sanitizeRelPath(rawName);
        if (!safePath) continue;

        let fileData: Buffer;
        if (compressionMethod === 0) {
            // Stored (no compression)
            fileData = buf.subarray(dataStart, dataStart + compressedSize);
        } else if (compressionMethod === 8) {
            // Deflated
            fileData = inflateRawSync(buf.subarray(dataStart, dataStart + compressedSize));
        } else {
            console.warn(`[clawhub] Skipping ${safePath}: unsupported compression method ${compressionMethod}`);
            continue;
        }

        const outPath = path.join(targetDir, safePath);
        await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
        await fs.promises.writeFile(outPath, fileData);
    }
}

function sanitizeRelPath(p: string): string | null {
    const normalized = p.replace(/^\.\/+/, '').replace(/^\/+/, '');
    if (!normalized || normalized.endsWith('/')) return null;
    if (normalized.includes('..') || normalized.includes('\\')) return null;
    return normalized;
}

// ─── Lock file helpers ───────────────────────────────────────────────────────

const DOT_DIR = '.clawhub';

async function readLockfile(workdir: string): Promise<LockfileData> {
    const paths = [
        path.join(workdir, DOT_DIR, 'lock.json'),
        path.join(workdir, '.clawdhub', 'lock.json'),
    ];

    for (const p of paths) {
        try {
            const raw = await fs.promises.readFile(p, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && parsed.skills) {
                return parsed as LockfileData;
            }
        } catch {
            // try next
        }
    }

    return { version: 1, skills: {} };
}

async function writeLockfile(workdir: string, lock: LockfileData): Promise<void> {
    const lockPath = path.join(workdir, DOT_DIR, 'lock.json');
    await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.promises.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

async function writeSkillOrigin(
    skillFolder: string,
    origin: {
        version: number;
        registry: string;
        slug: string;
        installedVersion: string;
        installedAt: number;
    },
): Promise<void> {
    const originPath = path.join(skillFolder, DOT_DIR, 'origin.json');
    await fs.promises.mkdir(path.dirname(originPath), { recursive: true });
    await fs.promises.writeFile(originPath, `${JSON.stringify(origin, null, 2)}\n`, 'utf8');
}

// ─── Main Service ────────────────────────────────────────────────────────────

export class ClawHubService {
    private workDir: string;

    constructor() {
        this.workDir = getOpenClawConfigDir();
        ensureDir(this.workDir);
    }

    /** Skills directory (workDir/skills) */
    private get skillsDir(): string {
        return path.join(this.workDir, 'skills');
    }

    /**
     * Search for skills via the ClawHub API
     */
    async search(params: ClawHubSearchParams): Promise<ClawHubSkillResult[]> {
        try {
            if (!params.query || params.query.trim() === '') {
                return this.explore({ limit: params.limit });
            }

            const url = new URL(ApiRoutes.search, REGISTRY);
            url.searchParams.set('q', params.query);
            if (params.limit) {
                url.searchParams.set('limit', String(params.limit));
            }

            const result = await apiFetch<SearchApiResult>(url.toString(), API_TIMEOUT_MS, await getOptionalAuthToken());

            return result.results.map((entry) => ({
                slug: entry.slug,
                name: entry.displayName || entry.slug,
                description: entry.summary || '',
                version: entry.version || 'latest',
            }));
        } catch (error) {
            console.error('ClawHub search error:', error);
            throw error;
        }
    }

    /**
     * Explore trending / latest skills
     */
    async explore(params: { limit?: number } = {}): Promise<ClawHubSkillResult[]> {
        try {
            const url = new URL(ApiRoutes.skills, REGISTRY);
            url.searchParams.set('limit', String(params.limit || 25));

            const result = await apiFetch<SkillListApiResult>(url.toString(), API_TIMEOUT_MS, await getOptionalAuthToken());

            return result.items.map((item) => ({
                slug: item.slug,
                name: item.displayName || item.slug,
                description: item.summary || '',
                version: item.latestVersion?.version || 'latest',
            }));
        } catch (error) {
            console.error('ClawHub explore error:', error);
            throw error;
        }
    }

    /**
     * Install a skill by downloading and extracting it
     */
    async install(params: ClawHubInstallParams): Promise<void> {
        const slug = params.slug.trim();
        if (!slug) throw new Error('Slug required');

        const target = path.join(this.skillsDir, slug);

        // Always remove existing directory on install (UI always expects success)
        if (fs.existsSync(target)) {
            await fs.promises.rm(target, { recursive: true, force: true });
        }

        const token = await getOptionalAuthToken();

        // 1. Resolve version
        let resolvedVersion = params.version;
        if (!resolvedVersion) {
            console.log(`[clawhub] Resolving latest version for: ${slug}`);
            const skillUrl = new URL(`${ApiRoutes.skills}/${encodeURIComponent(slug)}`, REGISTRY);
            const detail = await apiFetch<SkillDetailApiResult>(skillUrl.toString(), API_TIMEOUT_MS, token);
            resolvedVersion = detail.latestVersion?.version ?? undefined;
            if (!resolvedVersion) {
                throw new Error('Could not resolve latest version');
            }
        }

        // 2. Download zip with generous timeout
        console.log(`[clawhub] Downloading ${slug}@${resolvedVersion}`);
        const downloadUrl = new URL(ApiRoutes.download, REGISTRY);
        downloadUrl.searchParams.set('slug', slug);
        downloadUrl.searchParams.set('version', resolvedVersion);

        const zipBytes = await downloadBytes(downloadUrl.toString(), DOWNLOAD_TIMEOUT_MS, token);

        // 3. Extract
        console.log(`[clawhub] Extracting ${slug} to ${target}`);
        await extractZipToDir(zipBytes, target);

        // 4. Write origin metadata
        await writeSkillOrigin(target, {
            version: 1,
            registry: REGISTRY,
            slug,
            installedVersion: resolvedVersion,
            installedAt: Date.now(),
        });

        // 5. Update lockfile
        const lock = await readLockfile(this.workDir);
        lock.skills[slug] = {
            version: resolvedVersion,
            installedAt: Date.now(),
        };
        await writeLockfile(this.workDir, lock);

        console.log(`[clawhub] Installed ${slug}@${resolvedVersion}`);
    }

    /**
     * Uninstall a skill
     */
    async uninstall(params: ClawHubUninstallParams): Promise<void> {
        // 1. Delete the skill directory
        const skillDir = path.join(this.skillsDir, params.slug);
        if (fs.existsSync(skillDir)) {
            console.log(`[clawhub] Deleting skill directory: ${skillDir}`);
            await fs.promises.rm(skillDir, { recursive: true, force: true });
        }

        // 2. Remove from lock.json
        const lock = await readLockfile(this.workDir);
        if (lock.skills[params.slug]) {
            console.log(`[clawhub] Removing ${params.slug} from lock.json`);
            delete lock.skills[params.slug];
            await writeLockfile(this.workDir, lock);
        }
    }

    /**
     * List installed skills (from lockfile — no network request needed)
     */
    async listInstalled(): Promise<Array<{ slug: string; version: string }>> {
        try {
            const lock = await readLockfile(this.workDir);
            return Object.entries(lock.skills).map(([slug, entry]) => ({
                slug,
                version: entry.version || 'latest',
            }));
        } catch (error) {
            console.error('ClawHub list error:', error);
            return [];
        }
    }

    /**
     * Open skill README/manual in default editor
     */
    async openSkillReadme(slug: string): Promise<boolean> {
        const { shell } = await import('electron');
        const skillDir = path.join(this.skillsDir, slug);

        const possibleFiles = ['SKILL.md', 'README.md', 'skill.md', 'readme.md'];
        let targetFile = '';

        for (const file of possibleFiles) {
            const filePath = path.join(skillDir, file);
            if (fs.existsSync(filePath)) {
                targetFile = filePath;
                break;
            }
        }

        if (!targetFile) {
            if (fs.existsSync(skillDir)) {
                targetFile = skillDir;
            } else {
                throw new Error('Skill directory not found');
            }
        }

        try {
            await shell.openPath(targetFile);
            return true;
        } catch (error) {
            console.error('Failed to open skill readme:', error);
            throw error;
        }
    }
}
