// 回帰テスト
//
// ここに並んでいるのは、レビューで実際に見つかった不具合です。
// 「一度直したものが再発していないこと」を確認するのが目的なので、
// 修正のたびにケースを足していくこと。

import { suite, check, checkNear, checkTrue, withPage, finish } from './harness.mjs';

// 検証用の標準ビルド：全体攻撃力2600 / クリ率68% / クリダメ245% / スキル100%
// ③新規判定タブのサブステはパネル入力になったので、テストからは状態に直接入れる
const SETSUB = `
  function setNewSub(i, key, val) {
    if (!S.newSubs) S.newSubs = Array.from({length:5},()=>({key:'',val:''}));
    S.newSubs[i] = { key, val: String(val) };
    buildNewSubs();
  }
`;

// 登録データを使わない素のビルドなので、内訳はすべて「直接入力」に入る。
// 全体攻撃力2600 ＝ 基礎500 ＋ 実数2100。
const BUILD = SETSUB + `
  S.other = { base:'500', stat:'2100', cr:'68', cd:'245' };
  S.ratio={normal:0,heavy:0,skill:100,lib:0,echo:0};
`;

// ── サブステの正規データ ────────────────────────────────
suite('サブステ正規データ');
await withPage(async page => {
    const r = await page.evaluate(() => {
        const ev = k => expectedVal(SUB_STATS.find(s => s.key === k));
        const vals = k => SUB_STATS.find(s => s.key === k).vals;
        return {
            種類数: SUB_STATS.length,
            音骸スキルバフを含まない: !SUB_STATS.some(s => s.key === 'dmg_echo'),
            重み合計: Object.fromEntries(SUB_STATS.map(s => [s.key, wSum(s)])),
            長さ不一致: SUB_STATS.filter(s => s.w.length !== s.vals.length).map(s => s.key),
            期待値: {
                crit_rate: +ev('crit_rate').toFixed(3), crit_dmg: +ev('crit_dmg').toFixed(3),
                atk_pct: +ev('atk_pct').toFixed(3), def_pct: +ev('def_pct').toFixed(3),
                flat_atk: +ev('flat_atk').toFixed(3), flat_def: +ev('flat_def').toFixed(3),
                flat_hp: +ev('flat_hp').toFixed(2), res_eff: +ev('res_eff').toFixed(3),
            },
            値: { flat_atk: vals('flat_atk'), flat_def: vals('flat_def'), def_pct: vals('def_pct'), flat_hp: vals('flat_hp') },
        };
    });
    check('種類は13種（均等抽選 1/13）', r.種類数, 13);
    checkTrue('音骸スキルバフはサブステに含まれない', r.音骸スキルバフを含まない);
    check('重みと値の長さが一致', r.長さ不一致, []);
    check('クリ率・クリダメの重み合計は300', [r.重み合計.crit_rate, r.重み合計.crit_dmg], [300, 300]);
    check('その他の重み合計は103', [r.重み合計.atk_pct, r.重み合計.flat_atk, r.重み合計.flat_def], [103, 103, 103]);
    // 存在しない値を選択肢に出していた不具合
    check('固定攻撃力は4段階', r.値.flat_atk, [30, 40, 50, 60]);
    check('固定防御力は4段階（40始まり）', r.値.flat_def, [40, 50, 60, 70]);
    check('防御%の中間段', r.値.def_pct, [8.1, 9, 10, 10.9, 11.8, 12.8, 13.8, 14.7]);
    check('固定HPの3段目は390', r.値.flat_hp[2], 390);
    // 中間値ではなく重み付き期待値であること
    check('期待値が手計算と一致', r.期待値, {
        crit_rate: 7.53, crit_dmg: 15.06, atk_pct: 8.771, def_pct: 11.092,
        flat_atk: 43.689, flat_def: 53.495, flat_hp: 438.35, res_eff: 9.355,
    });
});

suite('抽選が重みに従う');
await withPage(async page => {
    const r = await page.evaluate(() => {
        const sd = SUB_STATS.find(s => s.key === 'crit_rate');
        let max = 0, bottom3 = 0; const N = 200000;
        for (let i = 0; i < N; i++) { const v = drawVal(sd); if (v === 10.5) max++; if (v <= 7.5) bottom3++; }
        return { max: max / N * 100, bottom3: bottom3 / N * 100 };
    });
    // 一様抽選だと最大値12.5% / 下位3段37.5%になる。重み付きなら3.0% / 70.0%。
    checkNear('クリ率の最大値を引く確率は約3.0%', r.max, 3.0, 0.25);
    checkNear('クリ率の下位3段は約70%', r.bottom3, 70.0, 0.5);
});

// ── クリ率・クリダメ ────────────────────────────────────
suite('クリ率:クリダメのバランス判定');
await withPage(async page => {
    const verdict = cd => page.evaluate(([b, cd]) => {
        eval(b); S.other.cd = cd; updateEdDisplay();
        return document.getElementById('balanceNote').textContent.trim();
    }, [BUILD, cd]);
    // クリダメは100%が基準点。増分(cd-100)と比較しないと判定が反転する
    checkTrue('68CR/245CD（ほぼ1:2）はバランス良好', (await verdict('245')).includes('バランス良好'));
    checkTrue('68CR/180CD はクリダメ不足', (await verdict('180')).includes('クリ率過多'));
    checkTrue('68CR/320CD はクリ率不足', (await verdict('320')).includes('クリダメ過多'));
});

suite('クリダメ未入力時の保護');
await withPage(async page => {
    const r = await page.evaluate(b => {
        eval(b); S.other.cd = '';
        const p = getPartials();
        updateEdDisplay();
        return { crit_factor: p.crit_factor, pCR: p.pCR, cd_unset: p.cd_unset, note: document.getElementById('balanceNote').textContent };
    }, BUILD);
    // 以前は crit_factor が1未満になり、クリ率の限界価値が負に転じていた
    check('クリ倍率は1.0（クリティカル分を含めない）', r.crit_factor, 1);
    check('クリ率の限界価値は負にならない', r.pCR, 0);
    checkTrue('未入力である旨を警告する', r.note.includes('クリダメが未入力'));
});

suite('クリ率100%の頭打ち');
await withPage(async page => {
    const r = await page.evaluate(b => {
        eval(b);
        const at = (cr, v, inc) => { S.other.cr = String(cr); return +mv('crit_rate', v, inc).toFixed(4); };
        const unit = (cr) => { S.other.cr = String(cr); return getPartials().pCR; };
        return {
            u95: unit(95),
            新規10_5_at95: at(95, 10.5, false), 新規3_at95: at(95, 3, false),
            新規_at105: at(105, 10.5, false), 装備済_at105: at(105, 10.5, true),
            装備済_at95: at(95, 10.5, true),
        };
    }, BUILD);
    // 95%のとき、新規に足せるのは上限までの5%分だけ
    checkNear('CR95%・新規+10.5% は5%分の価値', r.新規10_5_at95, r.u95 * 5, 1e-3);
    checkNear('CR95%・新規+3% は3%分すべて有効', r.新規3_at95, r.u95 * 3, 1e-3);
    check('CR105%・新規ロールは無価値', r.新規_at105, 0);
    // 装備済みは「抜いたらどうなるか」で測る。
    // CR105%から10.5%を抜くと94.5%になるので、失われるのは 100-94.5 = 5.5%分
    checkNear('CR105%・装備済み10.5% は5.5%分の価値', r.装備済_at105, r.u95 * 5.5, 1e-3);
    checkNear('CR95%・装備済み10.5% は全量有効', r.装備済_at95, r.u95 * 10.5, 1e-3);
});

// ── 登録データ ──────────────────────────────────────────
suite('固定プリセットが保存データに混入しない');
await withPage(async page => {
    const r = await page.evaluate(() => {
        charaType = 'weapon';
        const before = getCharaEntries('weapon').length;
        for (let i = 1; i <= 10; i++) { document.getElementById('ch_name').value = '武器' + i; addCharaEntry(); }
        const saved = JSON.parse(localStorage.getItem('echo_chara_weapon'));
        return {
            before, 固定: getCharaEntries('weapon').filter(e => e._builtin).length,
            ユーザー: getCharaEntries('weapon').filter(e => !e._builtin).length,
            保存件数: saved.length, 保存に固定が混入: saved.some(e => e._builtin),
        };
    });
    // 以前は登録のたびに固定プリセットが複製され、5→11→17と増えていた
    check('10回登録しても固定プリセットは5件のまま', r.固定, r.before);
    check('ユーザー登録は10件', r.ユーザー, 10);
    check('保存されるのはユーザー分のみ', [r.保存件数, r.保存に固定が混入], [10, false]);
});

suite('汚染された保存データの自動復旧');
await withPage(async page => {
    await page.evaluate(() => {
        const dup = () => BUILTIN_WEAPON.map((e, i) => ({ ...e, id: 'builtin_weapon_' + i, type: 'weapon', _builtin: true }));
        localStorage.setItem('echo_chara_weapon', JSON.stringify([...dup(), ...dup(), { id: 'ch_1', name: '本物の登録', type: 'weapon' }]));
    });
    await page.reload();
    await page.waitForFunction(() => typeof SUB_STATS !== 'undefined');
    const r = await page.evaluate(() => ({
        固定: getCharaEntries('weapon').filter(e => e._builtin).length,
        ユーザー: getCharaEntries('weapon').filter(e => !e._builtin).map(e => e.name),
        保存件数: JSON.parse(localStorage.getItem('echo_chara_weapon')).length,
        固定件数の実際: BUILTIN_WEAPON.length,
    }));
    check('起動時に重複が掃除される', [r.固定, r.保存件数], [r.固定件数の実際, 1]);
    check('本物の登録は残る', r.ユーザー, ['本物の登録']);
});

suite('バックアップの復元');
await withPage(async page => {
    const r = await page.evaluate(() => {
        const o = {};
        const dup = BUILTIN_WEAPON.map((e, i) => ({ ...e, id: 'builtin_weapon_' + i, type: 'weapon', _builtin: true }));
        importState({ __app: 'echo-optimizer', __ver: 2, data: { weapon: [...dup, { id: 'ch_9', name: '復元武器', type: 'weapon' }] } });
        o.復元後のユーザー分 = getCharaEntries('weapon').filter(e => !e._builtin).map(e => e.name);
        importState({ __app: 'echo-optimizer', data: { weapon: { 壊れた: 1 } } });
        o.不正な型を拒否 = Array.isArray(JSON.parse(localStorage.getItem('echo_chara_weapon')));
        document.getElementById('backupText').value = JSON.stringify({ __app: 'echo-optimizer', __ver: 99, data: {} });
        doImport();
        o.新形式を拒否 = document.getElementById('backupMsg').textContent;
        return o;
    });
    check('古いバックアップの重複は取り除かれる', r.復元後のユーザー分, ['復元武器']);
    checkTrue('配列以外は書き込まない', r.不正な型を拒否);
    checkTrue('新しい形式のバックアップは拒否する', r.新形式を拒否.includes('新しいバージョン'));
});

// ── 表示 ────────────────────────────────────────────────
suite('未入力スロットの扱い');
await withPage(async page => {
    const r = await page.evaluate(b => {
        eval(b);
        // 「不要なサブステは入力を省略する」使い方が壊れていないことを確認する
        S.echoes[0].main = { cost: 4, key1: 'crit_rate', val1: 22, key2: 'flat_atk', val2: 150 };
        S.echoes[0].subs = [{ key: 'crit_dmg', val: '21.0' }, { key: 'crit_rate', val: '10.5' },
        { key: 'atk_pct', val: '11.6' }, { key: 'dmg_skill', val: '9.4' }, { key: 'flat_atk', val: '50' }];
        S.echoes[1].main = { cost: 3, key1: 'atk_pct', val1: 30, key2: 'flat_atk', val2: 100 };
        S.echoes[1].subs = [{ key: 'crit_dmg', val: '16.2' }, { key: 'crit_rate', val: '8.1' },
        { key: '', val: '' }, { key: '', val: '' }, { key: '', val: '' }];
        buildEchoGrid(); recalcAll();
        return {
            省略スロットのスコア: echoScore(S.echoes[1]),
            未着手判定: S.echoes.map(e => isEchoUntouched(e)),
            順位表示: [...document.querySelectorAll('.rk-table tbody tr')].map(x => x.textContent.replace(/\s+/g, ' ').trim()),
        };
    }, BUILD);
    checkTrue('省略した枠があってもスコアは計上される', r.省略スロットのスコア > 0);
    check('入力のあるスロットは未着手扱いにしない', r.未着手判定, [false, false, true, true, true]);
    checkTrue('手つかずのスロットに未入力タグが付く', r.順位表示.filter(t => t.includes('未入力')).length === 3);
    checkTrue('手つかずのスロットに「最優先で更新」は出ない',
        !r.順位表示.some(t => t.includes('未入力') && t.includes('最優先')));
});

suite('入力値のエスケープ');
await withPage(async page => {
    const r = await page.evaluate(() => {
        const evil = '"><img src=x onerror=alert(1)>X';
        localStorage.setItem('echo_custom_h', JSON.stringify([{ id: 'h1', name: evil, attr: '不正な属性', setType: '2+5', set2: {}, set5: {}, desc: evil }]));
        localStorage.setItem('echo_chara_weapon', JSON.stringify([{ id: 'w1', name: evil, type: 'weapon', desc: evil, base_atk: 100 }]));
        localStorage.setItem('echo_chara_chara', JSON.stringify([{ id: 'c1', name: evil, type: 'chara', desc: evil, base_atk: 100 }]));
        localStorage.setItem('ww_echo_presets', JSON.stringify([{ name: evil, echoes: [] }]));
        charaType = 'weapon';
        buildHarmonyPicker(); renderCustomList(); renderCharaList(); rebuildPresetSelect(); rebuildCharaWeaponSelects();
        S.echoes[0].name = evil; buildEchoGrid(); recalcAll();
        return {
            注入されたタグ: document.querySelectorAll('img[src="x"]').length,
            音骸名が値として保たれる: document.querySelector('#ec_0 input[type=text]').value === evil,
            不正な属性でも描画できる: !!document.getElementById('hslot_0'),
        };
    });
    check('どの登録経路からもタグは注入されない', r.注入されたタグ, 0);
    checkTrue('音骸名は入力どおり保持される', r.音骸名が値として保たれる);
    checkTrue('未知の属性値でも描画が落ちない', r.不正な属性でも描画できる);
});

// ── 項目別モード ────────────────────────────────────────
suite('内訳が状態から計算される');
await withPage(async page => {
    const r = await page.evaluate(() => {
        const o = {};
        // 登録データ由来のバフ（ハーモニー）＋ ユーザーの「その他」入力
        S.harmony[0] = { id: 'リフレクト', setLevel: 5, custom: getPresetBuff('リフレクト', 5) };
        S.other = { base: '500', cr: '5', cd: '150', dlight: '10' };
        buildHarmonyPicker(); recalcAll();
        const D = detailBreakdown();
        o.ハーモニーの攻撃力が内訳に入る = D.statPct.h;
        o.その他のクリ率が内訳に入る = D.cr.other;
        o.クリダメ合計 = D.cd.total;
        o.回折バフ合計 = D.attr.light.total;
        const p = getPartials();
        o.計算に反映される = { cr: p.cr_eff, cd: p.cd_eff };

        // DOMの導出欄を書き換えても計算は変わらないこと（DOMを読んでいない証拠）
        document.getElementById('di_cr_h').value = '9999';
        o.DOM改変後のクリ率 = getPartials().cr_eff;

        // 「その他」欄はDOM経由の入力が状態に入ること
        onDetailOther('cr', '12');
        o.その他入力後のクリ率 = getPartials().cr_eff;

        // 再描画しても「その他」の入力が消えないこと
        fillDetailInputs();
        o.再描画後のその他欄 = document.getElementById('di_cr_other').value;
        o.導出欄は読み取り専用 = document.getElementById('di_cr_h').readOnly;
        return o;
    });
    check('登録データ由来のバフが内訳に入る', r.ハーモニーの攻撃力が内訳に入る, 30);
    check('「その他」入力が内訳に入る', r.その他のクリ率が内訳に入る, 5);
    check('クリダメ合計は「その他」のみ', r.クリダメ合計, 150);
    check('属性バフはハーモニー＋その他', r.回折バフ合計, 20);
    check('内訳が期待ダメージ計算に反映される', r.計算に反映される, { cr: 5, cd: 150 });
    // 以前は入力欄のDOMを直接読んでいたため、この改変で計算が変わってしまっていた
    check('導出欄のDOMを書き換えても計算は変わらない', r.DOM改変後のクリ率, 5);
    check('「その他」欄の入力は計算に反映される', r.その他入力後のクリ率, 12);
    check('再描画しても「その他」の入力は保持される', r.再描画後のその他欄, '12');
    checkTrue('導出欄は読み取り専用', r.導出欄は読み取り専用);
});

suite('確率計算の説明が実装と一致する');
await withPage(async page => {
    const t = await page.evaluate(() => document.body.textContent);
    checkTrue('「均等な確率」という記述が残っていない', !t.includes('均等な確率で出現'));
    checkTrue('「正規分布近似」という記述が残っていない', !t.includes('正規分布近似'));
});

// ── 通し動作 ────────────────────────────────────────────
suite('通し動作');
await withPage(async page => {
    const r = await page.evaluate(b => {
        eval(b);
        const o = {};
        S.echoes[0].subs = [{ key: 'crit_dmg', val: '21.0' }, { key: 'atk_pct', val: '11.6' },
        { key: 'flat_atk', val: '50' }, { key: 'dmg_skill', val: '9.4' }, { key: 'crit_rate', val: '7.5' }];
        buildEchoGrid(); recalcAll();
        o.E = Math.round(getPartials().E);
        // 新規判定
        document.getElementById('newLevel').value = '10'; buildNewSubs();
        setNewSub(0, 'crit_dmg', '12.6');
        document.getElementById('compareSlot').value = '0'; runJudge();
        o.判定結果あり = !!document.getElementById('judgeResult').textContent.trim();
        o.分布図あり = document.querySelectorAll('#probResult svg').length;
        o.比較行 = (document.getElementById('probResult').textContent.match(/育て/g) || []).length;
        // セット保存 → リセット → 呼び出し
        document.getElementById('echoPresetName').value = 'テスト'; saveEchoPreset();
        resetEquipTab(); document.getElementById('confirmOkBtn').click();
        o.リセット後 = echoScore(S.echoes[0]);
        loadEchoPreset ; document.getElementById('echoPresetSelect').value = '0'; loadEchoPreset();
        o.復元後 = Math.round(echoScore(S.echoes[0]));
        return o;
    }, BUILD);
    checkTrue('期待ダメージ指数が算出される', r.E > 0);
    checkTrue('新規判定が結果を出す', r.判定結果あり);
    check('分布図が描画される', r.分布図あり, 1);
    check('継続と新規の2案が並ぶ', r.比較行, 2);
    check('リセットでスコアが0になる', r.リセット後, 0);
    checkTrue('保存したセットを呼び戻せる', r.復元後 > 0);
});

// ── 入力内容の自動保存 ──────────────────────────────────
suite('入力内容がリロードで復元される');
await withPage(async page => {
    await page.evaluate(() => {
        S.other = { base: '500', stat: '2100', cr: '68', cd: '245' };
        S.ratio = { normal: 0, heavy: 0, skill: 80, lib: 20, echo: 0 };
        S.harmony[0] = { id: 'リフレクト', setLevel: 5, custom: getPresetBuff('リフレクト', 5) };
        S.other.cr = '75';
        S.echoes[0].name = 'テスト音骸';
        S.echoes[0].main = { cost: 4, key1: 'crit_rate', val1: 22, key2: 'flat_atk', val2: 150 };
        S.echoes[0].subs = [{ key: 'crit_dmg', val: '21.0' }, { key: 'atk_pct', val: '11.6' },
        { key: '', val: '' }, { key: '', val: '' }, { key: '', val: '' }];
        statMode = 'atk'; useAttr = 'light';
        buildHarmonyPicker(); buildEchoGrid(); recalcAll();
        saveState();
    });
    const before = await page.evaluate(() => ({ E: Math.round(getPartials().E), score: Math.round(echoScore(S.echoes[0])) }));
    await page.reload();
    await page.waitForFunction(() => typeof SUB_STATS !== 'undefined');
    const after = await page.evaluate(() => ({
        E: Math.round(getPartials().E), score: Math.round(echoScore(S.echoes[0])),
        base: S.other.base, cr: S.other.cr, ratio: S.ratio, useAttr,
        harmony: S.harmony[0].id, other: S.other.cr, name: S.echoes[0].name,
        cost: S.echoes[0].main.cost, subs: S.echoes[0].subs.filter(x => x.key).length,
        欄に値が入っている: document.getElementById('dt_base_in').value,
    }));
    check('期待ダメージ指数が一致', after.E, before.E);
    check('音骸スコアが一致', after.score, before.score);
    check('ステータス入力が戻る', [after.base, after.cr, after.欄に値が入っている], ['500', '75', '500']);
    check('ダメージ比率が戻る', after.ratio, { normal: 0, heavy: 0, skill: 80, lib: 20, echo: 0 });
    check('使用属性が戻る', after.useAttr, 'light');
    check('ハーモニー選択が戻る', after.harmony, 'リフレクト');
    check('「直接入力」が戻る', after.other, '75');
    check('音骸の名前・コスト・サブステが戻る', [after.name, after.cost, after.subs], ['テスト音骸', 4, 2]);
});

suite('壊れた保存データで起動できる');
await withPage(async page => {
    for (const bad of ['{', 'null', '{"__ver":1}', '{"__ver":99,"S":{}}', '{"__ver":1,"S":{"echoes":"壊れた","harmony":3}}']) {
        await page.evaluate(v => localStorage.setItem('ww_echo_state', v), bad);
        await page.reload();
        await page.waitForFunction(() => typeof SUB_STATS !== 'undefined');
        const ok = await page.evaluate(() => Array.isArray(S.echoes) && S.echoes.length === 5 && !!document.getElementById('ec_0'));
        checkTrue(`壊れた保存(${bad.slice(0, 22)})でも初期状態で起動する`, ok);
    }
});

suite('入力すると自動保存される');
await withPage(async page => {
    await page.evaluate(() => { const el = document.getElementById('di_stat_other'); el.value = '3000'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForTimeout(700);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ww_echo_state') || 'null'));
    checkTrue('入力後に保存が走る', saved && saved.S && saved.S.other && saved.S.other.stat === '3000');
});

// ── 厳密差分によるスコア ──────────────────────────────
suite('スコアが厳密差分で計算される');
await withPage(async page => {
    const r = await page.evaluate(b => {
        eval(b);
        const strong = [{ key: 'crit_dmg', val: '21.0' }, { key: 'crit_rate', val: '10.5' },
        { key: 'atk_pct', val: '11.6' }, { key: 'dmg_skill', val: '11.6' }, { key: 'flat_atk', val: '60' }];
        S.echoes[0].subs = JSON.parse(JSON.stringify(strong));
        S.echoes[1].subs = [{ key: 'crit_rate', val: '6.9' }, { key: 'flat_hp', val: '360' },
        { key: 'def_pct', val: '9.0' }, { key: 'atk_pct', val: '7.1' }, { key: 'res_eff', val: '7.6' }];
        buildEchoGrid(); recalcAll();
        const linear = e => e.subs.reduce((a, x) => a + (x.key && x.val !== '' ? mv(x.key, x.val) : 0), 0);
        const empty = Array.from({ length: 5 }, () => ({ key: '', val: '' }));
        return {
            厳密が線形より小さい: echoScoreAt(0) < linear(S.echoes[0]),
            過大評価の割合: +((linear(S.echoes[0]) - echoScoreAt(0)) / echoScoreAt(0) * 100).toFixed(1),
            // スロットを空にすればスコアは0
            空スロットは0: echoScoreAt(4),
            // 個別の按分値の合計がスロットのスコアに一致する
            個別合計: +subScoresAt(0).reduce((a, x) => a + x, 0).toFixed(6),
            スロット合計: +echoScoreAt(0).toFixed(6),
            // ②と③が同じ土俵に載っている
            同一サブステなら同スコア: Math.abs(scoreSubsOnSlot(0, JSON.parse(JSON.stringify(strong))) - echoScoreAt(0)) < 1e-9,
            // 状態は計算後に元へ戻っている
            状態が復元される: JSON.stringify(S.echoes[0].subs) === JSON.stringify(strong)
                && S.other.stat === '2100' && S.other.cr === '68' && S.other.cd === '245',
            比較用に空にしても壊れない: eWithSlotSubs(0, empty) > 0,
        };
    }, BUILD);
    checkTrue('線形近似より小さい値になる', r.厳密が線形より小さい);
    checkTrue('最大ロールでの過大評価が10%以上あった', r.過大評価の割合 > 10);
    check('空スロットのスコアは0', r.空スロットは0, 0);
    check('サブステ個別の合計がスロットのスコアに一致', r.個別合計, r.スロット合計);
    checkTrue('同じサブステなら②と③で同じスコアになる', r.同一サブステなら同スコア);
    checkTrue('スコア計算のあと状態が元に戻っている', r.状態が復元される);
    checkTrue('スロットを空にした計算が成立する', r.比較用に空にしても壊れない);
});

suite('厳密差分が積み上げ計算と一致する');
await withPage(async page => {
    const r = await page.evaluate(() => {
        S.other = { base: '500', cr: '40', cd: '190' };
        S.ratio = { normal: 0, heavy: 0, skill: 100, lib: 0, echo: 0 };
        S.echoes[0].subs = [{ key: 'crit_dmg', val: '21.0' }, { key: 'crit_rate', val: '10.5' },
        { key: '', val: '' }, { key: '', val: '' }, { key: '', val: '' }];
        recalcAll();
        const empty = Array.from({ length: 5 }, () => ({ key: '', val: '' }));
        const exact = getPartials().E - eWithSlotSubs(0, empty);
        return {
            一致: Math.abs(echoScoreAt(0) - exact) < 1e-9,
            正の値: echoScoreAt(0) > 0,
            その他が保たれる: S.other.cr === '40',
        };
    });
    checkTrue('スロットのスコアが期待ダメージ差と一致', r.一致);
    checkTrue('スコアが正の値になる', r.正の値);
    checkTrue('計算後に「その他」入力が保たれる', r.その他が保たれる);
});

// ── 入れ替え難易度 ────────────────────────────────────
suite('スロットの入れ替え難易度（上位◯%）');
await withPage(async page => {
    await page.evaluate(b => {
        eval(b);
        // 強い順に並べた5スロット
        S.echoes[0].subs = [{ key: 'crit_dmg', val: '21.0' }, { key: 'crit_rate', val: '10.5' },
        { key: 'atk_pct', val: '11.6' }, { key: 'dmg_skill', val: '11.6' }, { key: 'flat_atk', val: '60' }];
        S.echoes[1].subs = [{ key: 'crit_dmg', val: '16.2' }, { key: 'crit_rate', val: '8.1' },
        { key: 'atk_pct', val: '9.4' }, { key: 'flat_atk', val: '50' }, { key: 'res_eff', val: '8.4' }];
        S.echoes[2].subs = [{ key: 'crit_rate', val: '7.5' }, { key: 'atk_pct', val: '7.9' },
        { key: 'dmg_skill', val: '8.6' }, { key: 'flat_hp', val: '360' }, { key: 'def_pct', val: '9.0' }];
        S.echoes[3].subs = [{ key: 'crit_dmg', val: '13.8' }, { key: 'flat_atk', val: '40' },
        { key: 'hp_pct', val: '7.1' }, { key: 'def_pct', val: '8.1' }, { key: 'res_eff', val: '7.6' }];
        S.echoes[4].subs = [{ key: 'atk_pct', val: '6.4' }, { key: 'flat_hp', val: '320' },
        { key: 'def_pct', val: '9.9' }, { key: 'res_eff', val: '6.8' }, { key: 'flat_def', val: '40' }];
        buildEchoGrid(); recalcAll();
    }, BUILD);
    await page.waitForTimeout(900);
    const r = await page.evaluate(() => {
        const d = getDistributions();
        const tops = S.echoes.map((_, i) => slotTopPercent(i, d));
        const scores = S.echoes.map((_, i) => echoScoreAt(i));
        // 同じ入力で作り直しても同じ値になること
        distCache = { sig: null, byslot: null };
        const again = S.echoes.map((_, i) => slotTopPercent(i, getDistributions()));
        return {
            tops, scores, again,
            順位表示: [...document.querySelectorAll('.rk-table tbody tr')].map(x => x.textContent.replace(/\s+/g, ' ').trim()),
            分布の件数: d[0].length,
        };
    });
    // スコアが高いスロットほど「上位」に来る（＝入れ替えが難しい）
    const asc = r.scores.map((s, i) => ({ s, t: r.tops[i] })).sort((a, b) => a.s - b.s);
    checkTrue('スコアが高いほど上位%が小さくなる', asc.every((x, i) => i === 0 || x.t <= asc[i - 1].t));
    checkTrue('最強スロットは上位1%未満', r.tops[0] < 1);
    checkTrue('最弱スロットは大半の音骸に負ける', r.tops[4] > 80);
    check('固定シードなので再計算しても同じ値', r.again, r.tops);
    check('標本数', r.分布の件数, 2000);
    checkTrue('ランキングに上位%が表示される', r.順位表示.every(t => t.includes('上位') || t.includes('未入力')));
});

suite('確率と順位が毎回同じ値になる');
await withPage(async page => {
    const r = await page.evaluate(b => {
        eval(b);
        S.echoes[3].subs = [{ key: 'atk_pct', val: '7.9' }, { key: 'flat_atk', val: '40' },
        { key: '', val: '' }, { key: '', val: '' }, { key: '', val: '' }];
        buildEchoGrid(); recalcAll();
        document.getElementById('newLevel').value = '5'; buildNewSubs();
        setNewSub(0, 'flat_hp', '320');
        document.getElementById('compareSlot').value = '3';
        const runs = [];
        for (let i = 0; i < 5; i++) { runJudge(); runs.push(document.getElementById('probResult').innerHTML); }
        return { runs: runs.map(x => (x.match(/dc-val[^>]*>([\d.]+)%/) || [])[1]), ばらつきなし: new Set(runs).size === 1 };
    }, BUILD);
    // 以前はモンテカルロの乱数が毎回変わり、同じ入力でも±0.5ptほど揺れていた
    checkTrue('同じ入力なら確率が完全に一致する', r.ばらつきなし);
    checkTrue('確率が表示されている', /\d/.test(r.runs[0] || ''));
});

// ── 新規判定の分布図 ──────────────────────────────────
suite('新規音骸の最終スコア分布');
await withPage(async page => {
    const r = await page.evaluate(b => {
        eval(b);
        S.echoes[0].subs = [{ key: 'crit_dmg', val: '16.2' }, { key: 'crit_rate', val: '8.1' },
        { key: 'atk_pct', val: '9.4' }, { key: 'flat_atk', val: '50' }, { key: 'res_eff', val: '8.4' }];
        buildEchoGrid(); recalcAll();
        document.getElementById('newLevel').value = '10'; buildNewSubs();
        [['crit_dmg', '15'], ['crit_rate', '8.1']].forEach(([k, v], i) => {
            setNewSub(i, k, v);
        });
        document.getElementById('compareSlot').value = '0';
        const t0 = performance.now(); runJudge(); const ms = performance.now() - t0;

        const box = document.getElementById('probResult');
        const runs = [];
        for (let i = 0; i < 3; i++) { runJudge(); runs.push(box.innerHTML); }

        // 標本の性質を直接確認する
        const E = getPartials().E;
        const fixed = [{ key: 'crit_dmg', val: '15' }, { key: 'crit_rate', val: '8.1' }];
        const cont = sampleFinalScores(0, fixed, 0x1F123BB5);
        const fresh = sampleFinalScores(0, [], 0x2C9E7A31);
        const line = echoScoreAt(0);
        return {
            ms: Math.round(ms),
            図がある: box.querySelectorAll('svg').length,
            決定的: new Set(runs).size === 1,
            昇順: cont[0] <= cont[cont.length - 1] && fresh[0] <= fresh[fresh.length - 1],
            標本数: cont.length,
            // 2枠を良ロールで固定しているぶん、+0からより下限が高い
            固定枠の下限が高い: cont[0] > fresh[0],
            継続の勝率: +shareAtLeast(cont, line).toFixed(1),
            新規の勝率: +shareAtLeast(fresh, line).toFixed(1),
            合格ラインが表示される: box.textContent.includes('合格ライン'),
            推奨が出る: /有利です|大差ありません/.test(box.textContent),
        };
    }, BUILD);
    check('分布図が描画される', r.図がある, 1);
    check('標本数', r.標本数, 2000);
    checkTrue('標本が昇順に並んでいる', r.昇順);
    checkTrue('良い枠を確保済みなら下限が上がる', r.固定枠の下限が高い);
    checkTrue('継続のほうが勝率が高い（良ロール2枠を確保済みのため）', r.継続の勝率 > r.新規の勝率);
    checkTrue('合格ラインが表示される', r.合格ラインが表示される);
    checkTrue('どちらが有利かの判断が出る', r.推奨が出る);
    checkTrue('同じ入力なら描画結果まで完全に一致する', r.決定的);
    checkTrue('判定が1秒以内に終わる', r.ms < 1000);
});

suite('全枠開放済みの新規音骸');
await withPage(async page => {
    const r = await page.evaluate(b => {
        eval(b);
        S.echoes[0].subs = [{ key: 'atk_pct', val: '7.9' }, { key: 'flat_atk', val: '40' },
        { key: '', val: '' }, { key: '', val: '' }, { key: '', val: '' }];
        buildEchoGrid(); recalcAll();
        // +25 は5枠すべて開放済みなので、伸びしろが無い
        document.getElementById('newLevel').value = '25'; buildNewSubs();
        [['crit_dmg', '21'], ['crit_rate', '10.5'], ['atk_pct', '11.6'], ['dmg_skill', '11.6'], ['flat_atk', '60']]
            .forEach(([k, v], i) => {
                setNewSub(i, k, v);
            });
        document.getElementById('compareSlot').value = '0';
        runJudge();
        const box = document.getElementById('probResult');
        return { 図がある: box.querySelectorAll('svg').length, 本文: box.textContent.replace(/\s+/g, ' ').trim() };
    }, BUILD);
    check('全枠開放済みでも図が出る', r.図がある, 1);
    checkTrue('伸びしろが無い旨が読み取れる', r.本文.includes('全枠開放済み'));
});

// ── 装備音骸ランキング（表形式） ────────────────────────
suite('ランキングが表形式で出る');
await withPage(async page => {
    await page.evaluate(b => {
        eval(b);
        S.echoes[0].subs = [{ key: 'crit_dmg', val: '21.0' }, { key: 'crit_rate', val: '10.5' },
        { key: 'atk_pct', val: '11.6' }, { key: 'dmg_skill', val: '11.6' }, { key: 'flat_atk', val: '60' }];
        // 価値0のサブステ（HP・防御・共鳴効率）だけのスロット
        S.echoes[1].subs = [{ key: 'flat_hp', val: '320' }, { key: 'def_pct', val: '9.9' },
        { key: 'res_eff', val: '6.8' }, { key: 'flat_def', val: '40' }, { key: 'hp_pct', val: '7.1' }];
        buildEchoGrid(); recalcAll();
    }, BUILD);
    await page.waitForTimeout(900);
    const r = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.rk-table tbody tr')];
        const idx = rows.findIndex(tr => tr.querySelector('.rk-name').textContent.includes('スロット1'));
        const weak = rows.findIndex(tr => tr.querySelector('.rk-name').textContent.includes('スロット2'));
        return {
            行数: rows.length,
            列数: rows[0].children.length,
            サブステが出る: rows[idx].querySelectorAll('.rk-sub').length,
            価値0が灰色: rows[weak].querySelectorAll('.rk-sub.dead').length,
            強スロットに灰色は無い: rows[idx].querySelectorAll('.rk-sub.dead').length,
            最優先は1つだけ: document.querySelectorAll('.rk-first').length,
            最優先が未入力でない: !rows.find(tr => tr.querySelector('.rk-first'))?.textContent.includes('未入力'),
            未入力は難易度が横棒: rows.filter(tr => tr.textContent.includes('未入力'))
                .every(tr => tr.querySelector('.rk-top').textContent.trim() === '—'),
            難易度カードが無い: !document.getElementById('difficultyBody'),
        };
    });
    check('5スロットぶんの行', r.行数, 5);
    check('6列（順位・名前・スコア・難易度・バー・サブステ）', r.列数, 6);
    check('サブステが行内に並ぶ', r.サブステが出る, 5);
    // このビルドでは HP・防御・共鳴効率はスコアに寄与しない
    check('価値0のサブステが灰色になる', r.価値0が灰色, 5);
    check('有効なサブステは灰色にならない', r.強スロットに灰色は無い, 0);
    check('「最優先」は1箇所だけ', r.最優先は1つだけ, 1);
    checkTrue('「最優先」は入力済みのスロットに付く', r.最優先が未入力でない);
    checkTrue('未入力スロットの難易度は表示しない', r.未入力は難易度が横棒);
    checkTrue('厳選難易度カードは無い', r.難易度カードが無い);
});

// ── 登録データの編集 ──────────────────────────────────
suite('ハーモニーの属性ダメバフ');
await withPage(async page => {
    const r = await page.evaluate(() => {
        setCAttr('ice', document.querySelector('#cAttrBtns .attr-sel-btn[data-attr="ice"]'), 'cAttrBtns');
        document.getElementById('cName').value = 'テスト氷';
        document.getElementById('cSetType').value = '2+5'; onCustomSetType('2+5');
        document.getElementById('cDmg').value = '30';
        document.getElementById('c2Dmg').value = '10';
        addCustomHarmony();
        const h = customHarmonies()[0];
        // 「その他」は全属性として扱う
        setCAttr('other', document.querySelector('#cAttrBtns .attr-sel-btn[data-attr="other"]'), 'cAttrBtns');
        document.getElementById('cName').value = 'テスト全';
        document.getElementById('cDmg').value = '20';
        addCustomHarmony();
        const all = customHarmonies()[1];
        return { attr: h.attr, ice5: h.set5.dmg_ice, all5: h.set5.dmg_all, ice2: h.set2.dmg_ice, otherAll: all.set5.dmg_all };
    });
    // 以前は選択した属性を無視して全属性バフとして保存していた
    check('選んだ属性のバフとして保存される', [r.attr, r.ice5, r.ice2], ['ice', 30, 10]);
    check('全属性には入らない', r.all5, 0);
    check('「その他」は全属性として保存される', r.otherAll, 20);
});

suite('登録データの編集');
await withPage(async page => {
    const r = await page.evaluate(() => {
        const o = {};
        // 武器
        charaType = 'weapon'; setRegType('weapon', null);
        document.getElementById('ch_name').value = 'テスト武器';
        document.getElementById('ch_base_atk').value = '500';
        document.getElementById('ch_crit_rate').value = '20';
        addCharaEntry();
        const before = getSavedCharaEntries('weapon')[0];
        editCharaEntry('weapon', before.id);
        o.フォームに戻る = [document.getElementById('ch_name').value,
        document.getElementById('ch_base_atk').value, document.getElementById('ch_crit_rate').value];
        o.ボタンが保存表示になる = document.querySelector('#tab-custom [onclick="addCharaEntry()"]').textContent.includes('変更を保存');
        document.getElementById('ch_crit_rate').value = '24.3';
        addCharaEntry();
        const list = getSavedCharaEntries('weapon');
        o.増えない = list.length;
        o.idが保たれる = list[0].id === before.id;
        o.更新される = list[0].crit_rate;
        o.ボタンが戻る = document.querySelector('#tab-custom [onclick="addCharaEntry()"]').textContent.includes('を登録');

        // ハーモニー
        setCAttr('fire', document.querySelector('#cAttrBtns .attr-sel-btn[data-attr="fire"]'), 'cAttrBtns');
        document.getElementById('cName').value = 'テストH';
        document.getElementById('cDmg').value = '30';
        addCustomHarmony();
        const h = customHarmonies()[0];
        editCustomHarmony(h.id);
        o.ハーモニーがフォームに戻る = [document.getElementById('cName').value, document.getElementById('cDmg').value];
        document.getElementById('cDmg').value = '40';
        addCustomHarmony();
        const after = customHarmonies();
        o.ハーモニーも増えない = after.length;
        o.ハーモニーのidが保たれる = after[0].id === h.id;
        o.ハーモニーが更新される = after[0].set5.dmg_fire;

        // 編集をやめる
        editCustomHarmony(after[0].id);
        cancelHarmonyEdit();
        o.やめるとフォームが空 = document.getElementById('cName').value === '';
        return o;
    });
    check('編集で既存の値がフォームに戻る', r.フォームに戻る, ['テスト武器', '500', '20']);
    checkTrue('ボタンが「変更を保存」になる', r.ボタンが保存表示になる);
    check('保存しても件数が増えない', r.増えない, 1);
    checkTrue('idが保たれる（選択が外れない）', r.idが保たれる);
    check('値が更新される', r.更新される, 24.3);
    checkTrue('保存後はボタンが「登録」に戻る', r.ボタンが戻る);
    check('ハーモニーもフォームに戻る', r.ハーモニーがフォームに戻る, ['テストH', '30']);
    check('ハーモニーも件数が増えない', r.ハーモニーも増えない, 1);
    checkTrue('ハーモニーのidが保たれる', r.ハーモニーのidが保たれる);
    check('ハーモニーの値が更新される', r.ハーモニーが更新される, 40);
    checkTrue('「編集をやめる」でフォームが空になる', r.やめるとフォームが空);
});

// ── キーボード操作 ────────────────────────────────────
suite('キーボードで操作できる');
await withPage(async page => {
    const r = await page.evaluate(() => {
        const els = [...document.querySelectorAll('[onclick]')];
        const unreachable = els.filter(e => !(e.tagName === 'BUTTON' || e.tagName === 'A' || e.hasAttribute('tabindex')));
        return {
            到達できない数: unreachable.length,
            // 残るのはモーダルの背景（Escで閉じられる）だけ
            残りの内訳: [...new Set(unreachable.map(e => String(e.className).split(' ')[0]))],
            // グリッド選択パネル化（gpk-*）でクラス名が変わった。選択肢自体は引き続きbutton
            選択肢がbutton: document.querySelectorAll('button.gpk-cell, button.gpk-tab, button.gpk-none').length,
        };
    });
    checkTrue('ハーモニー選択肢がボタンになっている', r.選択肢がbutton > 0);
    check('キーボードで到達できない操作は背景のみ', r.残りの内訳, ['modal-overlay']);
    check('その数', r.到達できない数, 2);

    // Escで閉じられること
    const esc = await page.evaluate(() => {
        openBackupModal();
        const before = document.getElementById('backupModal').classList.contains('open');
        onGlobalKeydown({ key: 'Escape' });
        return { before, after: document.getElementById('backupModal').classList.contains('open') };
    });
    checkTrue('Escでモーダルが閉じる', esc.before && !esc.after);
});

// ── 入力パネル ────────────────────────────────────────
suite('サブステをパネルから1タップで入力できる');
await withPage(async page => {
    const r = await page.evaluate(b => {
        eval(b); recalcAll();
        const o = {};
        // パネルを開いてセルを押すだけで種類と値が同時に決まる
        openPicker(0, 0);
        o.パネルが開く = !!document.querySelector('#ec_0 .pk-cell');
        pickSub(0, 0, 'crit_dmg', 7);
        o.一度で種類と値が入る = { ...S.echoes[0].subs[0] };
        // 押すと次の空き枠へ送られる
        o.次の枠へ送られる = picker && picker.si;
        pickSub(0, 1, 'crit_rate', 7);
        pickSub(0, 2, 'atk_pct', 7);
        pickSub(0, 3, 'dmg_skill', 7);
        pickSub(0, 4, 'flat_atk', 3);
        o.閉じる = picker === null;
        o.入力結果 = S.echoes[0].subs.map(x => x.key + ':' + x.val).join(',');
        // 使用済みの種類は選べない
        openPicker(0, 0);
        const row = [...document.querySelectorAll('#ec_0 .pk-mx tbody tr')]
            .find(tr => tr.querySelector('th').textContent === 'クリ率');
        o.使用済みは無効 = row.classList.contains('pk-used');
        closePicker();
        o.閉じられる = picker === null;
        // 消せる
        clearSub(0, 0);
        o.消せる = S.echoes[0].subs[0].key === '';
        return o;
    }, BUILD);
    checkTrue('パネルが開く', r.パネルが開く);
    check('1タップで種類と値が決まる', r.一度で種類と値が入る, { key: 'crit_dmg', val: '21' });
    check('次の空き枠へ自動で進む', r.次の枠へ送られる, 1);
    checkTrue('5枠そろうと自動で閉じる', r.閉じる);
    check('5枠すべて入る', r.入力結果, 'crit_dmg:21,crit_rate:10.5,atk_pct:11.6,dmg_skill:11.6,flat_atk:60');
    checkTrue('同じ種類は選べない', r.使用済みは無効);
    checkTrue('閉じられる', r.閉じられる);
    checkTrue('個別に消せる', r.消せる);
});

suite('コストとメインステを1タップで選べる');
await withPage(async page => {
    const r = await page.evaluate(b => {
        eval(b); recalcAll();
        const o = {};
        openMainPicker(0);
        o.選択肢の数 = document.querySelectorAll('#ec_0 .pk-chip').length;
        pickMain(0, 4, 'crit_dmg');
        o.両方決まる = { cost: S.echoes[0].main.cost, key1: S.echoes[0].main.key1, val1: S.echoes[0].main.val1 };
        o.固定枠も入る = { key2: S.echoes[0].main.key2, val2: S.echoes[0].main.val2 };
        o.選んだら閉じる = picker === null;
        // コスト1は固定枠がHP実数
        pickMain(1, 1, 'atk_pct');
        o.コスト1の固定枠 = { key2: S.echoes[1].main.key2, val2: S.echoes[1].main.val2 };
        // コスト合計の表示
        openMainPicker(2);
        o.合計表示 = document.querySelector('#ec_2 .pk-note').textContent.replace(/\s+/g, ' ').trim();
        closePicker();
        return o;
    }, BUILD);
    // コスト4が6種、コスト3が10種、コスト1が3種で全19通り
    check('選択肢は19通り', r.選択肢の数, 19);
    check('コストとメインステが同時に決まる', r.両方決まる, { cost: 4, key1: 'crit_dmg', val1: 44 });
    check('コストで決まる固定枠も入る', r.固定枠も入る, { key2: 'flat_atk', val2: 150 });
    checkTrue('選んだら閉じる', r.選んだら閉じる);
    check('コスト1の固定枠はHP実数', r.コスト1の固定枠, { key2: 'flat_hp', val2: 2280 });
    checkTrue('コスト合計が出る', r.合計表示.includes('コスト合計') && r.合計表示.includes('5'));
});

suite('コスト上限を超えると警告する');
await withPage(async page => {
    const r = await page.evaluate(b => {
        eval(b);
        // ゲーム上の上限は12。5枠すべてコスト4は成立しない
        [0, 1, 2, 3, 4].forEach(i => pickMain(i, 4, 'atk_pct'));
        openMainPicker(0);
        const note = document.querySelector('#ec_0 .pk-note');
        const o = { 文言: note.textContent.replace(/\s+/g, ' ').trim(), 色: note.getAttribute('style') || '' };
        closePicker();
        return o;
    }, BUILD);
    checkTrue('合計20と表示される', r.文言.includes('20'));
    checkTrue('超過を知らせる', r.文言.includes('上限を超えています'));
    checkTrue('赤で示す', r.色.includes('--red'));
});

suite('新規判定タブもパネル入力');
await withPage(async page => {
    const r = await page.evaluate(b => {
        eval(b); recalcAll();
        const o = {};
        document.getElementById('newLevel').value = '15'; buildNewSubs();
        openNewPicker(0);
        o.パネルが開く = !!document.querySelector('#newSubRows .pk-cell');
        pickNewSub(0, 'crit_dmg', 7);
        o.次へ送られる = newPicker;
        pickNewSub(1, 'crit_rate', 7);
        pickNewSub(2, 'atk_pct', 7);
        o.開放枠を埋めたら閉じる = newPicker === null;
        o.入力 = S.newSubs.slice(0, 3).map(x => x.key + ':' + x.val).join(',');
        // レベルを上げても消えない
        document.getElementById('newLevel').value = '25'; buildNewSubs();
        o.レベル変更後も残る = S.newSubs.slice(0, 3).map(x => x.key).join(',');
        return o;
    }, BUILD);
    checkTrue('パネルが開く', r.パネルが開く);
    check('次の枠へ進む', r.次へ送られる, 1);
    checkTrue('開放済みの枠を埋めたら閉じる', r.開放枠を埋めたら閉じる);
    check('入力が state に入る', r.入力, 'crit_dmg:21,crit_rate:10.5,atk_pct:11.6');
    check('レベルを上げても保持される', r.レベル変更後も残る, 'crit_dmg,crit_rate,atk_pct');
});

suite('新規音骸の入力がリロードで残る');
await withPage(async page => {
    await page.evaluate(b => {
        eval(b); recalcAll();
        document.getElementById('newLevel').value = '10'; buildNewSubs();
        pickNewSub(0, 'crit_dmg', 5);
        pickNewSub(1, 'crit_rate', 3);
        saveState();
    }, BUILD);
    await page.reload();
    await page.waitForFunction(() => typeof SUB_STATS !== 'undefined');
    const r = await page.evaluate(() => (S.newSubs || []).slice(0, 2).map(x => x.key + ':' + x.val).join(','));
    // 以前は DOM にしか無かったため、タブを離れるだけで消えていた
    check('新規音骸のサブステが復元される', r, 'crit_dmg:18.6,crit_rate:8.1');
});

suite('ダメージ比率のプリセット');
await withPage(async page => {
    const r = await page.evaluate(() => {
        const o = {};
        o.ボタン数 = document.querySelectorAll('.ratio-preset').length;
        applyRatioPreset(0); // 共鳴スキル主体
        o.比率 = { ...S.ratio };
        o.入力欄にも入る = ['r_n', 'r_h', 'r_s', 'r_l', 'r_e'].map(id => document.getElementById(id).value).join(',');
        o.合計 = document.getElementById('ratio_total_note').textContent.trim();
        o.選択中が1つ光る = document.querySelectorAll('.ratio-preset.on').length;
        S.ratio.normal = 50; updateRatioVis();
        o.手で変えたら消える = document.querySelectorAll('.ratio-preset.on').length;
        return o;
    });
    checkTrue('プリセットが並ぶ', r.ボタン数 >= 5);
    check('1タップで5項目が入る', r.比率, { normal: 0, heavy: 0, skill: 100, lib: 0, echo: 0 });
    check('入力欄にも反映される', r.入力欄にも入る, '0,0,100,0,0');
    check('合計100になる', r.合計, '= 100%');
    check('選択中のプリセットが分かる', r.選択中が1つ光る, 1);
    check('手動で変えると選択表示が外れる', r.手で変えたら消える, 0);
});

suite('パネルの見え方');
await withPage(async page => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const r = await page.evaluate(b => {
        eval(b); buildEchoGrid(); recalcAll();
        // 非表示のタブでは要素の寸法が取れないので、対象タブを開いてから測る
        [...document.querySelectorAll('.tab-btn')].find(x => x.textContent.includes('装備音骸')).click();
        openPicker(0, 0);
        const card = document.getElementById('ec_0');
        const pk = card.querySelector('.pk');
        const sc = card.querySelector('.pk-scroll');
        const tb = card.querySelector('.pk-mx');
        return {
            目印が付く: card.classList.contains('picking'),
            カード幅: Math.round(card.getBoundingClientRect().width),
            パネル幅: Math.round(pk.getBoundingClientRect().width),
            表の必要幅: Math.round(tb.scrollWidth),
            表示領域: Math.round(sc.clientWidth),
            はみ出せる: getComputedStyle(card).overflow === 'visible',
            ページ横スクロール: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        };
    }, BUILD);
    // カード幅に収まらない表を、狭い枠内でスクロールさせずに丸ごと見せる
    checkTrue('パネルを開いたカードに目印が付く', r.目印が付く);
    checkTrue('カードからはみ出せる', r.はみ出せる);
    checkTrue('パネルがカードより広い', r.パネル幅 > r.カード幅);
    checkTrue('表が横スクロールなしで収まる', r.表示領域 >= r.表の必要幅);
    checkTrue('ページ自体は横スクロールしない', !r.ページ横スクロール);

    // 閉じたら目印も外れる
    const closed = await page.evaluate(() => {
        closePicker();
        return document.getElementById('ec_0').classList.contains('picking');
    });
    checkTrue('閉じると目印が外れる', !closed);
});

suite('主要な入力欄が最初から開いている');
await withPage(async page => {
    const r = await page.evaluate(() => {
        const find = (tab, txt) => [...document.querySelectorAll(`#${tab} details`)]
            .find(d => d.querySelector('summary')?.textContent.includes(txt));
        [...document.querySelectorAll('.tab-btn')].find(x => x.textContent.includes('新規判定')).click();
        document.getElementById('newLevel').value = '15'; buildNewSubs();
        return {
            新規判定のサブステ: find('tab-new', '現在のサブステ')?.open,
            入力欄が見える: document.querySelector('#newSubRows .ec-sub-btn')?.offsetParent !== null,
        };
    });
    // そのタブの主目的にあたる入力欄が畳まれていると、何をすればいいか分からない
    checkTrue('新規判定タブのサブステ欄が開いている', r.新規判定のサブステ);
    checkTrue('サブステの入力欄が見えている', r.入力欄が見える);
});

suite('選択式の入力がまとまっている');
await withPage(async page => {
    const r = await page.evaluate(() => {
        const pick = document.getElementById('harmonyPicker');
        const detail = document.getElementById('block_detail');
        return {
            // 折りたたみの中に入れると、一次入力なのにページから消える
            選択ブロックの中: !!pick.closest('#select_block'),
            折りたたまれていない: !pick.closest('details'),
            見えている: pick.offsetParent !== null,
            // キャラ・武器と同じ「選ぶ入力」なので、数値の内訳より前に置く
            内訳より前: pick.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING ? true : false,
            キャラ選択も同じ枠: !!document.getElementById('sel_chara').closest('#select_block'),
        };
    });
    checkTrue('ハーモニーがキャラ・武器と同じ枠にある', r.選択ブロックの中);
    checkTrue('キャラ選択も同じ枠にある', r.キャラ選択も同じ枠);
    checkTrue('折りたたみに巻き込まれていない', r.折りたたまれていない);
    checkTrue('ハーモニー選択が見えている', r.見えている);
    checkTrue('数値の内訳より前に置かれる', r.内訳より前);
});

// ── 合計欄への直接入力 ──────────────────────────────────
suite('合計欄が入力と自動計算の両方を受ける');
await withPage(async page => {
    const r = await page.evaluate(() => {
        const o = {};
        S.other = {}; S.harmony = [{ id: '', setLevel: 5, custom: B() }, { id: '', setLevel: 5, custom: B() }];
        recalcAll();

        // ゲーム画面の数字をそのまま打ち込める
        setDetailTotal('dt_cr', '68');
        o.打った値がそのまま合計になる = detailBreakdown().cr.total;
        o.直接入力に入る = S.other.cr;
        o.注釈が出る = document.getElementById('dt_cr_note').textContent;

        // 合計は固定値ではなく差分として持つので、あとからバフが増えれば追従する
        S.harmony[0] = { id: '静寂', setLevel: 5, custom: getPresetBuff('静寂', 5) };
        buildHarmonyPicker(); recalcAll();
        const h = detailBreakdown().cr.h;
        o.バフ分だけ増える = Math.round((detailBreakdown().cr.total - (68 + h)) * 1e6);
        o.ハーモニー分がある = h;

        // 自動加算のほうが打った値より大きい場合、差分は負になる（正しい状態）
        setDetailTotal('dt_cr', '5');
        o.負の直接入力 = n(S.other.cr) < 0;
        o.負でも合計は打った値 = Math.round(detailBreakdown().cr.total * 1e6) / 1e6;
        o.負の注釈 = document.getElementById('dt_cr_note').className.includes('neg');

        // 空にすれば自動計算だけに戻る
        setDetailTotal('dt_cr', '');
        o.空にすると自動分のみ = detailBreakdown().cr.total;
        o.注釈も消える = document.getElementById('dt_cr_note').textContent;
        return o;
    });
    check('打った値がそのまま合計になる', r.打った値がそのまま合計になる, 68);
    check('差は「直接入力」へ回る', r.直接入力に入る, '68');
    checkTrue('直接入力を含む旨の注釈が出る', r.注釈が出る.includes('直接入力'));
    checkTrue('ハーモニーのクリ率が加算されている', r.ハーモニー分がある > 0);
    check('あとから増えたバフに合計が追従する', r.バフ分だけ増える, 0);
    checkTrue('自動分が上回ると直接入力は負になる', r.負の直接入力);
    check('負でも合計は打った値のまま', r.負でも合計は打った値, 5);
    checkTrue('負の直接入力は色を変えて示す', r.負の注釈);
    check('空にすると自動計算分だけに戻る', r.空にすると自動分のみ, r.ハーモニー分がある);
    check('注釈も消える', r.注釈も消える, '');
});

suite('手入力と自動計算が見分けられる');
await withPage(async page => {
    const r = await page.evaluate(() => {
        const items = [...document.querySelectorAll('#tab-stats .detail-item')];
        const manual = items.filter(x => x.classList.contains('manual'));
        return {
            欄がある: items.length,
            // 編集できる欄には必ず印が付いていること（逆も同じ）
            印の無い入力欄: items.filter(x => !x.classList.contains('manual') && !x.querySelector('input[readonly]')).length,
            編集できない手入力欄: manual.filter(x => x.querySelector('input[readonly]')).length,
            手入力の見出し: manual.length && getComputedStyle(manual[0].querySelector('label'), '::before').content,
            自動欄は点線: getComputedStyle(document.getElementById('di_cr_h')).borderStyle,
            手入力欄は実線: getComputedStyle(document.getElementById('di_cr_other')).borderStyle,
            色が違う: getComputedStyle(document.getElementById('di_cr_h')).backgroundColor
                !== getComputedStyle(document.getElementById('di_cr_other')).backgroundColor,
            凡例: [...document.querySelectorAll('#block_detail .input-legend span')].map(x => x.className),
        };
    });
    checkTrue('内訳の入力欄がある', r.欄がある > 20);
    check('編集できる欄には必ず印が付く', r.印の無い入力欄, 0);
    check('印の付いた欄は必ず編集できる', r.編集できない手入力欄, 0);
    checkTrue('手入力の見出しに印が入る', r.手入力の見出し.includes('✎'));
    // 色覚に依存しないよう、枠線の種類でも区別する
    check('自動計算の欄は点線', r.自動欄は点線, 'dashed');
    check('手入力の欄は実線', r.手入力欄は実線, 'solid');
    checkTrue('背景色も変える', r.色が違う);
    check('凡例が3種類出る', r.凡例, ['lg-auto', 'lg-manual', 'lg-total']);
});

suite('合計値入力モードが無い');
await withPage(async page => {
    const r = await page.evaluate(() => ({
        モード切替ボタン: !!document.getElementById('inputModeBtn_total'),
        合計値モードのブロック: !!document.getElementById('block_total'),
        切替関数: typeof setInputMode,
        内訳が最初から見えている: document.getElementById('block_detail').offsetParent !== null,
        キャラ武器の選択も見えている: document.getElementById('select_block').offsetParent !== null,
        属性バフの内訳が見えている: document.getElementById('di_attr_rows').children.length,
    }));
    checkTrue('モード切替ボタンは無い', !r.モード切替ボタン);
    checkTrue('合計値モードの入力欄は無い', !r.合計値モードのブロック);
    check('切替関数も残っていない', r.切替関数, 'undefined');
    checkTrue('内訳入力が最初から表示される', r.内訳が最初から見えている);
    checkTrue('キャラ・武器の選択が最初から表示される', r.キャラ武器の選択も見えている);
    check('属性バフの内訳が6属性ぶん生成される', r.属性バフの内訳が見えている, 6);
});

suite('タブのリセットが動く');
await withPage(async page => {
    const r = await page.evaluate(b => {
        eval(b);
        window.confirmDialog = (msg, fn) => fn();
        recalcAll();
        const before = detailBreakdown().cr.total;
        resetStatsTab();
        // セレクタ不正で querySelectorAll が例外を投げ、リセットが丸ごと落ちていた
        return { before, after: detailBreakdown().cr.total, other: JSON.stringify(S.other) };
    }, BUILD);
    check('リセット前はクリ率が入っている', r.before, 68);
    check('リセットで0に戻る', r.after, 0);
    check('直接入力も空になる', r.other, '{}');
});

// ── 配色 ────────────────────────────────────────────────
suite('白地で文字が読める');
await withPage(async page => {
    // 暗地から白基調へ戻したとき、暗地前提の色（淡い黄・淡い緑など）が
    // そのまま残っていると文字が沈む。目視では見落とすので機械的に測る。
    const r = await page.evaluate(b => {
        eval(b);
        S.harmony[0] = { id: '静寂', setLevel: 5, custom: getPresetBuff('静寂', 5) };
        S.echoes.forEach((e, i) => {
            e.main = { cost: i ? 3 : 4, key1: 'crit_rate', val1: 22, key2: 'flat_atk', val2: 150 };
            e.subs = [{ key: 'crit_dmg', val: '21.0' }, { key: 'crit_rate', val: '10.5' },
            { key: 'atk_pct', val: '11.6' }, { key: 'dmg_skill', val: '9.4' }, { key: 'flat_atk', val: '50' }];
        });
        buildHarmonyPicker(); buildEchoGrid(); recalcAll();
        document.querySelectorAll('details').forEach(d => d.open = true);

        const lum = c => { const [r2, g, bl] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r2 + 0.7152 * g + 0.0722 * bl; };
        const nums = x => (x.match(/[\d.]+/g) || []).map(Number);
        const rgb = x => nums(x).slice(0, 3);
        const alp = x => { const n = nums(x); return n.length > 3 ? n[3] : 1; };
        const over = (f, a, bk) => f.map((v, i) => v * a + bk[i] * (1 - a));
        const ratio = (a, bk) => { const l1 = lum(a), l2 = lum(bk); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
        const bgOf = el => {
            let n = el, st = [], acc = [240, 244, 248];
            while (n && n !== document.documentElement) { const cs = getComputedStyle(n); if (cs.backgroundColor && alp(cs.backgroundColor) > 0) st.push([rgb(cs.backgroundColor), alp(cs.backgroundColor)]); n = n.parentElement; }
            for (let i = st.length - 1; i >= 0; i--) acc = over(st[i][0], st[i][1], acc);
            return acc;
        };
        const bad = [];
        for (const el of document.querySelectorAll('body *')) {
            if (!el.offsetParent) continue;
            const box = el.getBoundingClientRect(); if (!box.width || !box.height) continue;
            const hasText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
            if (!hasText && !(el.tagName === 'INPUT' && el.value)) continue;
            const cs = getComputedStyle(el);
            const fs = parseFloat(cs.fontSize);
            const need = (fs >= 24 || (fs >= 18.66 && parseInt(cs.fontWeight) >= 700)) ? 3 : 4.5;
            const bk = bgOf(el);
            const c = ratio(over(rgb(cs.color), alp(cs.color), bk), bk);
            if (c < need) bad.push(`${el.tagName}.${(el.className || '').toString().split(' ')[0]} ${cs.color} ${fs}px ${c.toFixed(2)}`);
        }
        return [...new Set(bad)];
    }, BUILD);
    check('コントラスト不足の文字は無い', r, []);
});

suite('段階表示は濃いほど強い');
await withPage(async page => {
    const r = await page.evaluate(() => {
        const lum = h => { const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
        const cs = getComputedStyle(document.documentElement);
        const ramp = [1, 2, 3, 4, 5].map(i => cs.getPropertyValue('--g' + i + 'x').trim());
        return {
            段: ramp.length,
            単調に濃くなる: ramp.every((c, i) => i === 0 || lum(c) < lum(ramp[i - 1])),
            // 上位◯%の文字色にも使うので、濃い側は白地で読める必要がある
            文字に使う段: ramp.slice(2).map(c => +(( 1.05) / (lum(c) + 0.05)).toFixed(2)),
            価値0の文字色: cellTone(0, 1).fg,
            濃い段の文字色: [0.1, 0.3, 0.5, 0.7, 0.9].map(x => cellTone(x, 1).fg),
        };
    });
    check('5段ある', r.段, 5);
    // 白地なので「淡い→濃い」。暗地の並び（明るいほど強い）のままだと最上位が消える
    checkTrue('段が進むほど濃くなる', r.単調に濃くなる);
    checkTrue('文字にも使う段は白地で4.5:1以上', r.文字に使う段.every(v => v >= 4.5));
    // 段と文字色の境目がずれると、濃い地に濃い文字が載る
    check('濃い段には明色の文字を載せる', r.濃い段の文字色,
        ['var(--text)', 'var(--text)', 'var(--on-g)', 'var(--on-g)', 'var(--on-g)']);
    check('価値0のセルは灰色のまま', r.価値0の文字色, 'var(--text3)');
});

// ── 登録タブ：ハーモニーが固定プリセットごと出る ──────────────
suite('登録タブにハーモニーの固定プリセットが出る');
await withPage(async page => {
    const r = await page.evaluate(() => {
        // 以前は customHarmonies()（ユーザー登録分）しか見ておらず、
        // ①タブのピッカーには30件出るのに登録タブには1件も出ない食い違いがあった
        const items = [...document.querySelectorAll('#customList .custom-item')];
        return {
            表示件数: items.length,
            全ハーモニー件数: allHarmonies().length,
            固定件数: HARMONIES.length,
            固定バッジの数: items.filter(x => x.textContent.includes('固定')).length,
            固定に編集ボタンが無い: items.every(x => {
                const isBuiltin = x.textContent.includes('固定');
                const hasEditBtn = !!x.querySelector('button');
                return !isBuiltin || !hasEditBtn;
            }),
        };
    });
    check('表示件数がallHarmonies()と一致', r.表示件数, r.全ハーモニー件数);
    checkTrue('固定プリセットが30件以上ある', r.固定件数 >= 30);
    check('固定バッジの数がHARMONIES件数と一致', r.固定バッジの数, r.固定件数);
    checkTrue('固定プリセットには編集・削除ボタンが出ない', r.固定に編集ボタンが無い);
});

suite('登録タブでユーザー追加ハーモニーも共存する');
await withPage(async page => {
    const r = await page.evaluate(() => {
        const before = allHarmonies().length;
        document.getElementById('cName').value = 'テストハーモニー';
        document.getElementById('cSetType').value = '2+5'; onCustomSetType('2+5');
        addCustomHarmony();
        const items = [...document.querySelectorAll('#customList .custom-item')];
        const mine = items.find(x => x.textContent.includes('テストハーモニー'));
        return {
            増えた件数: allHarmonies().length - before,
            自分の登録に編集削除ボタンがある: !!(mine && mine.querySelectorAll('button').length === 2),
            自分の登録に固定バッジが無い: !!(mine && !mine.textContent.includes('固定')),
        };
    });
    check('ユーザー登録が1件増える', r.増えた件数, 1);
    checkTrue('ユーザー登録には編集・削除ボタンが出る', r.自分の登録に編集削除ボタンがある);
    checkTrue('ユーザー登録に固定バッジは付かない', r.自分の登録に固定バッジが無い);
});

// ── ダメージ比率：登録キャラ由来は「合計100%」警告を出さない ──
suite('登録キャラのratioは合計100%警告の対象外');
await withPage(async page => {
    const r = await page.evaluate(() => {
        const o = {};
        const findCharaId = name => getCharaEntries('chara').find(e => e.name === name)?.id;

        // デュアルタイプ（合計200%）
        document.getElementById('sel_chara').value = findCharaId('仇遠S0');
        onCharaWeaponChange(); recalcAll();
        o.デュアルタイプの合計 = S.ratio.echo + S.ratio.heavy;
        o.デュアルタイプで警告が出ない = document.getElementById('ratio_warn').style.display === 'none';
        o.デュアルタイプの表示 = document.getElementById('ratio_total_note').textContent;

        // 純ヒーラー（合計0%）
        document.getElementById('sel_chara').value = findCharaId('モーニエS0');
        onCharaWeaponChange(); recalcAll();
        o.ヒーラーの合計 = S.ratio.normal + S.ratio.heavy + S.ratio.skill + S.ratio.lib + S.ratio.echo;
        o.ヒーラーで警告が出ない = document.getElementById('ratio_warn').style.display === 'none';

        // 手で1つでも触ると、以後は通常の警告に戻る
        document.getElementById('r_n').value = '30';
        document.getElementById('r_n').dispatchEvent(new Event('input', { bubbles: true }));
        o.手入力後は警告が戻る = document.getElementById('ratio_warn').style.display === 'block';

        // 通常（100%）のキャラでは今まで通り警告なし
        document.getElementById('sel_chara').value = findCharaId('ツバキS0');
        onCharaWeaponChange(); recalcAll();
        o.通常キャラは合計100 = S.ratio.normal + S.ratio.lib;
        o.通常キャラで警告なし = document.getElementById('ratio_warn').style.display === 'none';
        return o;
    });
    check('仇遠は音骸スキル+重撃とも100%（合計200）', r.デュアルタイプの合計, 200);
    checkTrue('デュアルタイプでも「合計100%」警告は出ない', r.デュアルタイプで警告が出ない);
    checkTrue('その旨の表示が出る', r.デュアルタイプの表示.includes('登録キャラの配分'));
    check('モーニエのratioは全項目0', r.ヒーラーの合計, 0);
    checkTrue('ヒーラー（合計0%）でも警告は出ない', r.ヒーラーで警告が出ない);
    checkTrue('手で編集した後は通常の警告に戻る', r.手入力後は警告が戻る);
    check('通常のキャラ（ツバキ）は合計100', r.通常キャラは合計100, 100);
    checkTrue('通常のキャラでは元々警告が出ない', r.通常キャラで警告なし);
});

// ── キャラ・武器の収録データ拡充 ──────────────────────────
suite('収録キャラ・武器データの整合性');
await withPage(async page => {
    const r = await page.evaluate(() => {
        const CH_FIELDS_KNOWN = new Set(['base_atk', 'base_hp', 'base_def', 'atk_pct', 'flat_atk', 'hp_pct', 'flat_hp',
            'def_pct', 'crit_rate', 'crit_dmg', 'dmg_fire', 'dmg_ice', 'dmg_thunder', 'dmg_wind', 'dmg_light',
            'dmg_dark', 'dmg_all', 'dmg_normal', 'dmg_heavy', 'dmg_skill', 'dmg_lib', 'dmg_echo',
            'name', 'desc', 'attr', 'ratio', 'weaponType']);
        const ATTRS = new Set(['fire', 'ice', 'thunder', 'wind', 'light', 'dark', 'other', '']);
        const badKeys = [];
        [...BUILTIN_CHARA, ...BUILTIN_WEAPON].forEach(e => Object.keys(e).forEach(k => {
            if (!CH_FIELDS_KNOWN.has(k)) badKeys.push(`${e.name}:${k}`);
        }));
        const badAttr = BUILTIN_CHARA.filter(e => e.attr && !ATTRS.has(e.attr)).map(e => e.name);
        const dupeNames = arr => { const seen = new Set(), dup = []; arr.forEach(n => { if (seen.has(n)) dup.push(n); seen.add(n); }); return dup; };
        const weaponTypes = new Set(BUILTIN_WEAPON.map(e => e.weaponType));
        return {
            キャラ数: BUILTIN_CHARA.length,
            武器数: BUILTIN_WEAPON.length,
            スキーマ外キー: badKeys,
            不正な属性: badAttr,
            キャラ名重複: dupeNames(BUILTIN_CHARA.map(e => e.name)),
            武器名重複: dupeNames(BUILTIN_WEAPON.map(e => e.name)),
            武器種別が全件にある: BUILTIN_WEAPON.every(e => !!e.weaponType),
            武器種別の種類数: weaponTypes.size,
            属性なしキャラ: BUILTIN_CHARA.filter(e => !e.attr).map(e => e.name),
        };
    });
    checkTrue('キャラは40件以上収録', r.キャラ数 >= 40);
    checkTrue('武器は40件以上収録', r.武器数 >= 40);
    check('スキーマ外のキーは無い', r.スキーマ外キー, []);
    check('不正な属性値は無い', r.不正な属性, []);
    check('キャラ名の重複は無い', r.キャラ名重複, []);
    check('武器名の重複は無い', r.武器名重複, []);
    checkTrue('全武器に武器種別が設定されている', r.武器種別が全件にある);
    check('武器種別は5種類（長刃・迅刀・拳銃・手甲・増幅器）', r.武器種別の種類数, 5);
    check('属性未設定のキャラは無い（カルテジアは気動）', r.属性なしキャラ, []);
});

// ── グリッド選択パネル ──────────────────────────────────
suite('ハーモニー選択がグリッドパネルになっている');
await withPage(async page => {
    const r = await page.evaluate(() => {
        document.getElementById('hsel_wrap_0').querySelector('.custom-sel-btn').click();
        const list = document.getElementById('hsel_list_0');
        const tabs = [...list.querySelectorAll('.gpk-tab')].map(t => t.textContent.trim());
        const activeTab = list.querySelector('.gpk-tab.active')?.textContent.trim();
        const cellsBeforeSwitch = list.querySelector('.gpk-grid[style=""]')?.querySelectorAll('.gpk-cell').length
            ?? [...list.querySelectorAll('.gpk-grid')].find(g => g.style.display !== 'none').querySelectorAll('.gpk-cell').length;
        // 「気動」タブに切り替える
        const windTab = [...list.querySelectorAll('.gpk-tab')].find(t => t.textContent.includes('気動'));
        windTab.click();
        const visibleAfter = [...list.querySelectorAll('.gpk-grid')].filter(g => g.style.display !== 'none');
        const windCell = visibleAfter[0]?.querySelector('.gpk-cell');
        windCell.click();
        return {
            タブ件数: tabs.length,
            初期タブ: activeTab,
            初期セル数: cellsBeforeSwitch,
            切替後に表示されるグリッドは1つ: visibleAfter.length,
            選択後にパネルが閉じる: !document.getElementById('hsel_list_0').classList.contains('open'),
            選択後のハーモニー: allHarmonies().find(x => x.id === S.harmony[0].id)?.attr,
        };
    });
    checkTrue('属性タブが複数ある', r.タブ件数 >= 5);
    checkTrue('最初のタブが開いている', !!r.初期タブ);
    checkTrue('最初のタブにセルがある', r.初期セル数 > 0);
    check('タブ切替で表示されるグリッドは1つだけ', r.切替後に表示されるグリッドは1つ, 1);
    checkTrue('セルを選ぶとパネルが閉じる', r.選択後にパネルが閉じる);
    check('選んだタブの属性が実際に反映される', r.選択後のハーモニー, 'wind');
});

suite('キャラ・武器選択もグリッドパネルになっている');
await withPage(async page => {
    const r = await page.evaluate(() => {
        const o = {};
        // キャラ：属性タブで絞ってから選ぶ
        document.querySelector('#cwPicker_chara .custom-sel-btn').click();
        const charaList = document.getElementById('cwsel_list_chara');
        o.キャラのタブがある = charaList.querySelectorAll('.gpk-tab').length > 0;
        const iceTab = [...charaList.querySelectorAll('.gpk-tab')].find(t => t.textContent.includes('凝縮'));
        iceTab.click();
        const iceCell = [...charaList.querySelectorAll('.gpk-grid')].find(g => g.style.display !== 'none').querySelector('.gpk-cell');
        const pickedName = iceCell.textContent.trim();
        iceCell.click();
        o.キャラ選択が隠しselectに反映される = document.getElementById('sel_chara').value !== '';
        o.選んだキャラ名が一致 = getCharaEntries('chara').find(e => e.id === document.getElementById('sel_chara').value)?.name === pickedName;
        o.加算欄に反映される = document.getElementById('note_charaweapon').textContent.includes('基礎攻撃力');

        // 武器：武器種別タブで絞ってから選ぶ
        document.querySelector('#cwPicker_weapon .custom-sel-btn').click();
        const weaponList = document.getElementById('cwsel_list_weapon');
        const tabNames = [...weaponList.querySelectorAll('.gpk-tab')].map(t => t.textContent.trim());
        o.武器タブが武器種別 = ['長刃', '迅刀', '拳銃', '手甲', '増幅器'].every(t => tabNames.includes(t));
        const gunTab = [...weaponList.querySelectorAll('.gpk-tab')].find(t => t.textContent.includes('拳銃'));
        gunTab.click();
        const gunCell = [...weaponList.querySelectorAll('.gpk-grid')].find(g => g.style.display !== 'none').querySelector('.gpk-cell');
        gunCell.click();
        o.武器選択も隠しselectに反映される = document.getElementById('sel_weapon').value !== '';

        // 「なし」で解除できる
        document.querySelector('#cwPicker_chara .custom-sel-btn').click();
        document.getElementById('cwsel_list_chara').querySelector('.gpk-none').click();
        o.なしで解除できる = document.getElementById('sel_chara').value === '';
        return o;
    });
    checkTrue('キャラ選択に属性タブがある', r.キャラのタブがある);
    checkTrue('キャラ選択が隠しselectに反映される', r.キャラ選択が隠しselectに反映される);
    checkTrue('選んだキャラ名が一致する', r.選んだキャラ名が一致);
    checkTrue('選ぶと加算欄に反映される', r.加算欄に反映される);
    checkTrue('武器選択のタブが武器種別になっている', r.武器タブが武器種別);
    checkTrue('武器選択も隠しselectに反映される', r.武器選択も隠しselectに反映される);
    checkTrue('「なし」を選ぶと解除できる', r.なしで解除できる);
});

suite('グリッドパネルが画面内に収まる');
await withPage(async page => {
    await page.setViewportSize({ width: 390, height: 900 });
    const r = await page.evaluate(() => {
        document.querySelector('#cwPicker_chara .custom-sel-btn').click();
        const list = document.getElementById('cwsel_list_chara');
        const rect = list.getBoundingClientRect();
        return {
            画面右にはみ出さない: rect.right <= window.innerWidth + 1,
            画面左にはみ出さない: rect.left >= -1,
            ページ横スクロールなし: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        };
    });
    checkTrue('パネルが画面右にはみ出さない', r.画面右にはみ出さない);
    checkTrue('パネルが画面左にはみ出さない', r.画面左にはみ出さない);
    checkTrue('ページ自体は横スクロールしない', r.ページ横スクロールなし);
});

// ── ハーモニーの収録データ拡充（Ver3.4〜3.5分） ──────────────
suite('未収録だった4種のハーモニーが追加されている');
await withPage(async page => {
    const r = await page.evaluate(() => {
        const byId = id => HARMONIES.find(h => h.id === id);
        const mei = byId('冥夜'), jo = byId('浄心'), kyo = byId('玄翎虚滅'), kori = byId('玄翎結霜');
        return {
            件数: HARMONIES.length,
            id重複: HARMONIES.map(h => h.id).filter((v, i, a) => a.indexOf(v) !== i),
            冥夜あり: !!mei, 冥夜setType: mei?.setType,
            浄心あり: !!jo, 浄心attr: jo?.attr,
            玄翎虚滅あり: !!kyo, 玄翎結霜あり: !!kori,
            // 共鳴効率+10%（2セット）は未対応フィールドなので反映されない前提
            玄翎虚滅の2セット: kyo?.set2,
            玄翎結霜の2セット: kori?.set2,
            // 5セットは「共鳴効率が十分確保されている」前提の上限値（+25%）で固定
            玄翎結霜の5セットatk: kori?.set5?.atk_pct,
        };
    });
    check('ハーモニーは34件（既存30+新規4）', r.件数, 34);
    check('id重複は無い', r.id重複, []);
    checkTrue('冥夜を導く灯が追加されている', r.冥夜あり);
    check('冥夜は2+5セット', r.冥夜setType, '2+5');
    checkTrue('煞を祓う浄心が追加されている', r.浄心あり);
    check('浄心の属性は気動', r.浄心attr, 'wind');
    checkTrue('羽舞う塵世の歌(虚滅編成)が追加されている', r.玄翎虚滅あり);
    checkTrue('羽舞う塵世の歌(結霜編成)が追加されている', r.玄翎結霜あり);
    check('虚滅編成の2セットは未対応フィールドのため空', r.玄翎虚滅の2セット, {
        atk_pct: 0, hp_pct: 0, def_pct: 0,
        dmg_fire: 0, dmg_ice: 0, dmg_thunder: 0, dmg_wind: 0, dmg_light: 0, dmg_dark: 0, dmg_all: 0,
        crit_rate: 0, crit_dmg: 0,
        dmg_normal: 0, dmg_heavy: 0, dmg_skill: 0, dmg_lib: 0, dmg_echo: 0,
    });
    check('結霜編成の5セットは上限値+25%で固定', r.玄翎結霜の5セットatk, 25);
});

suite('新規ハーモニーが①タブの選択パネルに出る');
await withPage(async page => {
    const r = await page.evaluate(() => {
        document.getElementById('hsel_wrap_0').querySelector('.custom-sel-btn').click();
        const list = document.getElementById('hsel_list_0');
        // 玄翎虚滅・玄翎結霜は attr:'other' なので「その他」タブに入る
        const otherTab = [...list.querySelectorAll('.gpk-tab')].find(t => t.textContent.includes('その他'));
        otherTab.click();
        const cells = [...list.querySelectorAll('.gpk-grid')].find(g => g.style.display !== 'none')
            .querySelectorAll('.gpk-cell');
        const names = [...cells].map(c => c.textContent.trim());
        return { names };
    });
    checkTrue('冥夜を導く灯が「その他」タブから選べる', r.names.some(n => n.includes('冥夜')));
    checkTrue('虚滅編成が選べる', r.names.some(n => n.includes('虚滅編成')));
    checkTrue('結霜編成が選べる', r.names.some(n => n.includes('結霜編成')));
});

suite('フリーズフレームR1がスクリーンショットの実測値で収録されている');
await withPage(async page => {
    const r = await page.evaluate(() => {
        const w = BUILTIN_WEAPON.find(e => e.name === 'フリーズフレームR1');
        return w ? {
            あり: true, base_atk: w.base_atk, crit_rate: w.crit_rate,
            atk_pct: w.atk_pct, dmg_ice: w.dmg_ice, weaponType: w.weaponType,
        } : { あり: false };
    });
    checkTrue('フリーズフレームR1が収録されている', r.あり);
    check('基礎攻撃力587', r.base_atk, 587);
    check('メインステはクリ率24.3%', r.crit_rate, 24.3);
    // 攻撃力+12%（常時）＋ チーム攻撃力+24%（結霜後）の合算
    check('攻撃力%は常時12+条件付き24の合算', r.atk_pct, 36);
    check('凝縮ダメージ+30%（結霜後、自身）', r.dmg_ice, 30);
    check('武器種別は増幅器', r.weaponType, '増幅器');
});

suite('偽物の矮星R1のスクリーンショット照合で見つかった欠落を修正');
await withPage(async page => {
    const r = await page.evaluate(() => {
        const w = BUILTIN_WEAPON.find(e => e.name === '偽物の矮星R1');
        return w ? { atk_pct: w.atk_pct, crit_rate: w.crit_rate, dmg_lib: w.dmg_lib } : null;
    });
    // 元データは常時分の12%だけで、条件付きのチーム攻撃力+24%が抜けていた
    check('攻撃力%は常時12+条件付き24の合算', r.atk_pct, 36);
    check('メインステはクリ率36%のまま', r.crit_rate, 36);
    check('共鳴解放ダメージ+36%のまま', r.dmg_lib, 36);
});

suite('追加の資料照合で見つかった3件の修正が反映されている');
await withPage(async page => {
    const r = await page.evaluate(() => {
        const phoebe = BUILTIN_CHARA.find(e => e.name === 'フィービーS0');
        const kori = BUILTIN_WEAPON.find(e => e.name === '氷華の雅印R1');
        const ito = BUILTIN_WEAPON.find(e => e.name === '糸繰りの奇術R1');
        const yugasumi = BUILTIN_WEAPON.find(e => e.name === '夕霞の飲露R1');
        return {
            フィービーratio: phoebe.ratio,
            氷華dmg_normal: kori.dmg_normal,
            糸繰りatk_pct: ito.atk_pct,
            夕霞desc: yugasumi.desc,
        };
    });
    // 「共鳴スキル：清浄なるコンフェッション」はモード切替名でありダメージ種別ではない。
    // 実際の出力は通常攻撃+重撃（武器「光のハルモニア」の対応バフとも整合）
    check('フィービーのratioは通常攻撃+重撃', r.フィービーratio, { normal: 100, heavy: 100 });
    check('氷華の雅印は未登場時の最大値52', r.氷華dmg_normal, 52);
    check('糸繰りの奇術に登場時のatk_pct24が入っている', r.糸繰りatk_pct, 24);
    checkTrue('夕霞の飲露はルシラーではなく穂穂の武器と訂正されている', r.夕霞desc.includes('穂穂'));
    checkTrue('夕霞の飲露にルシラーの記載は残っていない', !r.夕霞desc.includes('ルシラー'));
});

await finish();
