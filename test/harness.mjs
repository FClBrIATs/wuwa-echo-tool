// テスト基盤
//
// 方針：ソースを分割してビルドする方式は取らない。
// 配布物である echo-optimizer-v5.index.html をそのままブラウザで開き、
// ページ内の関数を直接呼んで検証する。単一HTMLの編集フローを崩さずに
// 「壊れていないこと」を機械的に確認できるようにするのが目的。
//
// 実行: npm test
// 初回のみ: npx playwright install chromium

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const TOOL_URL = 'file://' + resolve(HERE, '..', 'echo-optimizer-v5.index.html');

// CI やコンテナでは実行可能パスを明示できるようにしておく
const EXECUTABLE = process.env.CHROMIUM_PATH || undefined;

let browser = null;
const results = [];
let currentSuite = '';

export function suite(name) { currentSuite = name; }

function record(ok, name, detail) {
    results.push({ ok, suite: currentSuite, name, detail });
    const mark = ok ? '\x1b[32m  ok\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    console.log(`${mark}  ${name}`);
    if (!ok && detail) console.log(`        ${detail}`);
}

export function check(name, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    record(a === e, name, a === e ? '' : `期待 ${e} / 実際 ${a}`);
}

export function checkNear(name, actual, expected, tol = 1e-6) {
    const ok = Math.abs(actual - expected) <= tol;
    record(ok, name, ok ? '' : `期待 ${expected}±${tol} / 実際 ${actual}`);
}

export function checkTrue(name, actual) { check(name, !!actual, true); }

// 毎回まっさらな状態のページを渡す。
// localStorage が前のテストに汚染されないよう、テストごとにコンテキストを作り直す。
export async function withPage(fn) {
    if (!browser) browser = await chromium.launch({ executablePath: EXECUTABLE });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message)));
    page.on('console', m => { if (m.type() === 'error' && !/ERR_(CONNECTION|NAME|INTERNET)/.test(m.text())) errors.push('console: ' + m.text()); });
    await page.goto(TOOL_URL);
    await page.waitForFunction(() => typeof SUB_STATS !== 'undefined');
    try {
        await fn(page);
        if (errors.length) record(false, '（JSエラーが発生していないこと）', errors.join(' / '));
    } finally {
        await ctx.close();
    }
}

export async function finish() {
    if (browser) await browser.close();
    const failed = results.filter(r => !r.ok);
    console.log('\n' + '─'.repeat(56));
    console.log(`${results.length} 件中 ${results.length - failed.length} 件成功, ${failed.length} 件失敗`);
    if (failed.length) {
        console.log('\n失敗:');
        for (const f of failed) console.log(`  [${f.suite}] ${f.name}\n      ${f.detail}`);
        process.exitCode = 1;
    }
}
