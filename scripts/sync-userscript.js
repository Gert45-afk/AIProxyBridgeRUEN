#!/usr/bin/env node
// ============================================================================
// sync-userscript.js — keep the arenaExecFactory copies identical
//
// The Tampermonkey userscript (LMArena.js) cannot require() files, so it holds
// an inline copy of arenaExecFactory from src/arena-client.js between the
// SYNC-WITH-ARENA-CLIENT markers. This script performs the sync mechanically
// (string-aware brace matching, 4-space re-indent) and verifies the result:
//   node scripts/sync-userscript.js [--check]
// --check only verifies that everything is in sync (exit 1 when it is not).
// ============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ARENA_CLIENT = path.join(ROOT, 'src', 'arena-client.js');
const USERSCRIPT = path.join(ROOT, 'LMArena.js');
const USERSCRIPT_COPY = path.join(ROOT, 'scripts', 'bridge-userscript.js');

const FACTORY_SIGNATURE = 'function arenaExecFactory()';

// String/comment/regex-aware balanced-brace extractor.
// The factory source must not use template literals (backticks) — keep it that way.
function extractFunctionSource(src, signature, baseIndent) {
    const start = src.indexOf((baseIndent || '') + signature);
    if (start === -1) throw new Error('signature not found: ' + signature);
    let i = src.indexOf('{', start);
    let depth = 0;
    let state = 'normal'; // normal | sq | dq | line | block | regex
    let prevSignificant = '('; // treat a leading slash as a regex
    for (; i < src.length; i++) {
        const c = src[i];
        const n1 = src[i + 1];
        if (state === 'sq') { if (c === '\\') i++; else if (c === "'") state = 'normal'; continue; }
        if (state === 'dq') { if (c === '\\') i++; else if (c === '"') state = 'normal'; continue; }
        if (state === 'line') { if (c === '\n') state = 'normal'; continue; }
        if (state === 'block') { if (c === '*' && n1 === '/') { state = 'normal'; i++; } continue; }
        if (state === 'regex') {
            if (c === '\\') { i++; continue; }
            if (c === '[') { // character class — skip to its close
                i++;
                while (i < src.length) {
                    if (src[i] === '\\') { i += 2; continue; }
                    if (src[i] === ']') break;
                    i++;
                }
                continue;
            }
            if (c === '/') state = 'normal';
            continue;
        }
        // normal state
        if (c === "'") { state = 'sq'; continue; }
        if (c === '"') { state = 'dq'; continue; }
        if (c === '`') throw new Error('backtick found inside the synced region — template literals are forbidden in arenaExecFactory');
        if (c === '/' && n1 === '/') { state = 'line'; i++; continue; }
        if (c === '/' && n1 === '*') { state = 'block'; i++; continue; }
        if (c === '/') {
            // '/' starts a regex when the previous significant token puts us in expression position
            if (prevSignificant === '' || '=(,:;!&|?{}[+-*%^~<>'.indexOf(prevSignificant) !== -1) {
                state = 'regex';
            }
            continue;
        }
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
        if (!/\s/.test(c)) prevSignificant = c;
    }
    throw new Error('unbalanced braces while extracting ' + signature);
}

function indentBlock(block, prefix) {
    return block.split('\n').map(l => (l.trim() === '' ? l : prefix + l)).join('\n');
}

function dedentBlock(block, prefix) {
    return block.split('\n').map(l => (l.startsWith(prefix) ? l.slice(prefix.length) : l)).join('\n');
}

function replaceSyncedRegion(userscriptSource, newIndentedFactory) {
    const lines = userscriptSource.split('\n');
    const beginMarker = lines.findIndex(l => l.includes('SYNC-WITH-ARENA-CLIENT') && l.includes('inline copy'));
    if (beginMarker === -1) throw new Error('userscript: SYNC-WITH-ARENA-CLIENT begin marker not found');
    const startIdx = lines.findIndex((l, i) => i > beginMarker && l.startsWith('    ' + FACTORY_SIGNATURE));
    if (startIdx === -1) throw new Error('userscript: indented ' + FACTORY_SIGNATURE + ' not found');
    const endMarker = lines.findIndex(l => l.includes('END SYNC-WITH-ARENA-CLIENT'));
    if (endMarker === -1 || endMarker <= startIdx) throw new Error('userscript: END marker not found after the factory');
    // The factory's closing brace is the last line "    }" before the END comment block
    let endIdx = -1;
    for (let i = endMarker - 1; i > startIdx; i--) {
        if (lines[i] === '    }') { endIdx = i; break; }
    }
    if (endIdx === -1) throw new Error('userscript: factory closing brace not found');
    const out = lines.slice(0, startIdx).concat(newIndentedFactory.split('\n')).concat(lines.slice(endIdx + 1));
    return out.join('\n');
}

function main() {
    const checkOnly = process.argv.includes('--check');

    const arenaClient = fs.readFileSync(ARENA_CLIENT, 'utf8');
    const factory = extractFunctionSource(arenaClient, FACTORY_SIGNATURE, '');
    if (factory.includes('`')) throw new Error('arenaExecFactory contains backticks');

    const userscript = fs.readFileSync(USERSCRIPT, 'utf8');
    const synced = replaceSyncedRegion(userscript, indentBlock(factory, '    '));

    // Verify: re-extract from the replaced content and compare byte-for-byte
    const reExtracted = dedentBlock(extractFunctionSource(synced, FACTORY_SIGNATURE, '    '), '    ');
    if (reExtracted !== factory) {
        throw new Error('sync verification failed: userscript copy differs from src/arena-client.js');
    }

    const currentUserscript = fs.readFileSync(USERSCRIPT, 'utf8');
    const currentCopy = fs.readFileSync(USERSCRIPT_COPY, 'utf8');
    const inSync = (synced === currentUserscript) && (currentCopy === currentUserscript);

    if (checkOnly) {
        if (!inSync) {
            console.error('OUT OF SYNC — run: node scripts/sync-userscript.js');
            process.exit(1);
        }
        console.log('OK: userscript is in sync with src/arena-client.js and both copies are identical');
        return;
    }

    fs.writeFileSync(USERSCRIPT, synced, 'utf8');
    fs.writeFileSync(USERSCRIPT_COPY, synced, 'utf8');
    console.log('Synced arenaExecFactory into LMArena.js and scripts/bridge-userscript.js');
}

main();
