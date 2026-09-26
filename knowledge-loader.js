/**
 * js/knowledge-loader.js
 * ------------------------------------------------------------------------
 * Loads RizKa GPT's external personal-knowledge system:
 *   - knowledge/rizwinth.json    { systemPrompt, entries: [the k1-k10 personal
 *                                  knowledge entries] } — the base admin-editable
 *                                  system prompt now lives here too, alongside
 *                                  the personal knowledge entries.
 *   - knowledge/instructions.txt (AI instructions for using that knowledge)
 *
 * and exposes a small, framework-free API on window.RizwinthKnowledgeLoader
 * that index.html's main app script uses to (a) fetch + cache the files and
 * (b) search the loaded entries for whatever is relevant to a user's message.
 *
 * IMPORTANT — hosting requirement:
 * fetch() cannot read local files when index.html is opened directly from
 * disk via the file:// protocol (browsers block file:// XHR/fetch for
 * security reasons, and this shows up as a CORS or "Failed to fetch" error).
 * These knowledge files therefore only load successfully when this site is
 * served over http/https, e.g.:
 *     npx serve .
 *     python3 -m http.server 8080
 *     any static web host (Netlify, GitHub Pages, nginx, etc.)
 * If served incorrectly (or the files are missing/unreachable), this module
 * falls back to a previously cached copy in localStorage, or otherwise
 * returns empty/neutral defaults and logs a warning — the app keeps working,
 * it just won't have Rizwinth's personal knowledge available until the files
 * can be reached.
 * ------------------------------------------------------------------------
 */
(function (global) {
    'use strict';

    const KNOWLEDGE_URL = 'rizwinth.json';
    const INSTRUCTIONS_URL = 'instructions.txt';

    // localStorage keys used purely as an offline/error fallback cache, so a
    // user who has successfully loaded the files once won't lose them if a
    // later fetch temporarily fails (flaky network, server briefly down, etc).
    const CACHE_KEY_KNOWLEDGE = 'rizka_gpt_knowledge_cache_v1';
    const CACHE_KEY_INSTRUCTIONS = 'rizka_gpt_instructions_cache_v1';
    const CACHE_KEY_SYSTEM_PROMPT = 'rizka_gpt_system_prompt_cache_v1';

    // Minimal, non-personal fallback used only if there is genuinely nothing
    // else to fall back on (no successful fetch, ever, and no cache). Keeps
    // the AI instructed not to invent facts even when the knowledge file
    // itself couldn't be loaded.
    const FALLBACK_INSTRUCTIONS =
        '[KNOWLEDGE BASE INSTRUCTIONS]\nThe external Rizwinth knowledge file could not be loaded. ' +
        'Do not invent or guess personal facts about Rizwinth. If asked, say that specific personal ' +
        'information is not currently available.';

    let knowledgeCache = null;      // in-memory cache for this page session
    let instructionsCache = null;   // in-memory cache for this page session
    let systemPromptCache = null;   // in-memory cache for this page session
    let rawFilePromise = null;      // in-flight fetch of knowledge/rizwinth.json, shared by
                                     // loadKnowledge() and loadSystemPrompt() so the file is
                                     // only fetched once even though both pull from it.

    function readLocalCache(key) {
        try {
            const raw = localStorage.getItem(key);
            return raw !== null ? raw : null;
        } catch (e) {
            return null;
        }
    }

    function writeLocalCache(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (e) {
            // Storage full/unavailable — non-fatal, just skip caching.
        }
    }

    /**
     * Fetches knowledge/rizwinth.json exactly once per page session and shares
     * the in-flight promise between loadKnowledge() and loadSystemPrompt(),
     * since both now read from that single file.
     *
     * knowledge/rizwinth.json's shape is:
     *   { "systemPrompt": "...", "entries": [ {id, title, category, content}, ... ] }
     * For backward compatibility, a bare JSON array (the old shape, with no
     * systemPrompt) is also accepted and treated as { entries: <that array> }.
     *
     * @returns {Promise<{systemPrompt: string, entries: Array}>}
     */
    function fetchRizwinthFile() {
        if (rawFilePromise) return rawFilePromise;

        rawFilePromise = (async () => {
            const res = await fetch(KNOWLEDGE_URL, { cache: 'no-cache' });
            if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching ' + KNOWLEDGE_URL);
            const data = await res.json();

            if (Array.isArray(data)) {
                // Old shape: bare array of entries, no systemPrompt field.
                return { systemPrompt: '', entries: data };
            }
            if (data && typeof data === 'object') {
                return {
                    systemPrompt: typeof data.systemPrompt === 'string' ? data.systemPrompt : '',
                    entries: Array.isArray(data.entries) ? data.entries : []
                };
            }
            throw new Error('knowledge/rizwinth.json did not contain a recognized JSON shape');
        })();

        return rawFilePromise;
    }

    /**
     * Fetches the knowledge entries out of knowledge/rizwinth.json (with
     * in-memory + localStorage caching and graceful fallback on failure).
     * Always resolves — never rejects — so callers don't need try/catch for
     * the "file missing" case.
     * @returns {Promise<Array<{id:string, title:string, category:string, content:string}>>}
     */
    async function loadKnowledge() {
        if (knowledgeCache) return knowledgeCache;

        try {
            const { entries } = await fetchRizwinthFile();
            if (!Array.isArray(entries)) throw new Error('knowledge/rizwinth.json "entries" was not an array');

            // Basic shape validation + de-duplication by id, so a malformed or
            // hand-edited file can't silently break the app or introduce dupes.
            const seen = new Set();
            const cleaned = entries.filter(entry => {
                if (!entry || typeof entry !== 'object') return false;
                if (!entry.id || !entry.title || !entry.content) return false;
                if (seen.has(entry.id)) return false;
                seen.add(entry.id);
                return true;
            }).map(entry => ({
                id: String(entry.id),
                title: String(entry.title),
                category: entry.category ? String(entry.category) : '',
                content: String(entry.content)
            }));

            knowledgeCache = cleaned;
            writeLocalCache(CACHE_KEY_KNOWLEDGE, JSON.stringify(cleaned));
            return cleaned;
        } catch (err) {
            console.warn('[KnowledgeLoader] Failed to fetch entries from ' + KNOWLEDGE_URL + ':', err);
            const cached = readLocalCache(CACHE_KEY_KNOWLEDGE);
            if (cached) {
                try {
                    const parsed = JSON.parse(cached);
                    if (Array.isArray(parsed)) {
                        knowledgeCache = parsed;
                        return parsed;
                    }
                } catch (e2) { /* fall through to empty default */ }
            }
            knowledgeCache = [];
            return [];
        }
    }

    /**
     * Fetches the base system prompt out of knowledge/rizwinth.json's
     * "systemPrompt" field (with in-memory + localStorage caching and
     * graceful fallback on failure). Always resolves — never rejects.
     * Resolves to "" if the file has no systemPrompt (old-shape file, fetch
     * failure with no cache, etc.) so callers know to fall back to their own
     * hardcoded default rather than blanking the prompt out.
     * @returns {Promise<string>}
     */
    async function loadSystemPrompt() {
        if (systemPromptCache !== null) return systemPromptCache;

        try {
            const { systemPrompt } = await fetchRizwinthFile();
            if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
                throw new Error('knowledge/rizwinth.json has no non-empty "systemPrompt" field');
            }
            systemPromptCache = systemPrompt;
            writeLocalCache(CACHE_KEY_SYSTEM_PROMPT, systemPrompt);
            return systemPrompt;
        } catch (err) {
            console.warn('[KnowledgeLoader] Failed to fetch systemPrompt from ' + KNOWLEDGE_URL + ':', err);
            const cached = readLocalCache(CACHE_KEY_SYSTEM_PROMPT);
            if (cached) {
                systemPromptCache = cached;
                return cached;
            }
            systemPromptCache = '';
            return '';
        }
    }

    /**
     * Fetches knowledge/instructions.txt (with in-memory + localStorage caching
     * and graceful fallback on failure). Always resolves — never rejects.
     * @returns {Promise<string>}
     */
    async function loadInstructions() {
        if (instructionsCache !== null) return instructionsCache;

        try {
            const res = await fetch(INSTRUCTIONS_URL, { cache: 'no-cache' });
            if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching ' + INSTRUCTIONS_URL);
            const text = await res.text();
            instructionsCache = text;
            writeLocalCache(CACHE_KEY_INSTRUCTIONS, text);
            return text;
        } catch (err) {
            console.warn('[KnowledgeLoader] Failed to fetch ' + INSTRUCTIONS_URL + ':', err);
            const cached = readLocalCache(CACHE_KEY_INSTRUCTIONS);
            if (cached) {
                instructionsCache = cached;
                return cached;
            }
            instructionsCache = FALLBACK_INSTRUCTIONS;
            return FALLBACK_INSTRUCTIONS;
        }
    }

    /**
     * Searches a list of knowledge entries for relevance to a free-text query.
     * Matches on keywords, entry title, category, and (lightweight) semantic
     * overlap via word-stem/substring matching against the entry content —
     * i.e. names, topics, and phrases mentioned in the question are checked
     * against both the title/category metadata and the body text.
     *
     * @param {Array<{id,title,category,content}>} entries
     * @param {string} query
     * @returns {Array} matched entries, in original order
     */
    function search(entries, query) {
        if (!Array.isArray(entries) || entries.length === 0 || !query) return [];

        const queryLower = String(query).toLowerCase();
        const keywords = queryLower.split(/\W+/).filter(w => w.length > 2);
        if (keywords.length === 0 && !queryLower.trim()) return [];

        return entries.filter(entry => {
            const title = (entry.title || '').toLowerCase();
            const category = (entry.category || '').toLowerCase();
            const content = (entry.content || '').toLowerCase();

            // Whole-phrase match (handles multi-word names/titles directly).
            if (title && queryLower.includes(title)) return true;
            if (content && queryLower.includes(content.slice(0, 40)) && content.length <= 40) return true;

            // Keyword overlap against title words, category, and content.
            const titleMatch = title && title.split(/\W+/).some(kw => keywords.includes(kw));
            const categoryMatch = category && keywords.includes(category);
            const contentMatch = content && (content.includes(queryLower) || keywords.some(kw => content.includes(kw)));

            return titleMatch || categoryMatch || contentMatch;
        });
    }

    /**
     * Convenience helper: runs search() and formats matched entries into the
     * bracketed context block the AI prompt expects. Returns "" if nothing
     * matched (so callers can just concatenate the result onto a prompt).
     * @param {Array} entries
     * @param {string} query
     * @returns {string}
     */
    function buildContext(entries, query) {
        const matched = search(entries, query);
        if (matched.length === 0) return '';
        let out = '\n\n[RELEVANT PERSONAL KNOWLEDGE BASE CONTEXT INJECTED]:\n';
        matched.forEach((item, i) => {
            out += (i + 1) + '. [' + item.title + '] (' + item.category + '): ' + item.content + '\n';
        });
        return out;
    }

    global.RizwinthKnowledgeLoader = {
        loadKnowledge: loadKnowledge,
        loadInstructions: loadInstructions,
        loadSystemPrompt: loadSystemPrompt,
        search: search,
        buildContext: buildContext
    };
})(window);
