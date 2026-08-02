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

const BUILD = SETSUB + `
  S.base_stat='500'; S.total_stat='2600'; S.crit_rate='68'; S.crit_dmg='245';
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
        eval(b); S.crit_dmg = cd; updateEdDisplay();
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
        eval(b); S.crit_dmg = '';
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
        const at = (cr, v, inc) => { S.crit_rate = String(cr); return +mv('crit_rate', v, inc).toFixed(4); };
        const unit = (cr) => { S.crit_rate = String(cr); return getPartials().pCR; };
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
    }));
    check('起動時に重複が掃除される', [r.固定, r.保存件数], [5, 1]);
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
suite('項目別モードが状態から計算される');
await withPage(async page => {
    const r = await page.evaluate(() => {
        const o = {};
        setInputMode('detail', null);
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
        S.base_stat = '500'; S.total_stat = '2600'; S.crit_rate = '68'; S.crit_dmg = '245';
        S.ratio = { normal: 0, heavy: 0, skill: 80, lib: 20, echo: 0 };
        S.harmony[0] = { id: 'リフレクト', setLevel: 5, custom: getPresetBuff('リフレクト', 5) };
        S.other = { cr: '7' };
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
        base: S.base_stat, cr: S.crit_rate, ratio: S.ratio, useAttr,
        harmony: S.harmony[0].id, other: S.other.cr, name: S.echoes[0].name,
        cost: S.echoes[0].main.cost, subs: S.echoes[0].subs.filter(x => x.key).length,
        欄に値が入っている: document.getElementById('inp_total').value,
    }));
    check('期待ダメージ指数が一致', after.E, before.E);
    check('音骸スコアが一致', after.score, before.score);
    check('ステータス入力が戻る', [after.base, after.cr, after.欄に値が入っている], ['500', '68', '2600']);
    check('ダメージ比率が戻る', after.ratio, { normal: 0, heavy: 0, skill: 80, lib: 20, echo: 0 });
    check('使用属性が戻る', after.useAttr, 'light');
    check('ハーモニー選択が戻る', after.harmony, 'リフレクト');
    check('項目別の「その他」が戻る', after.other, '7');
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
    await page.evaluate(() => { const el = document.getElementById('inp_total'); el.value = '3000'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForTimeout(700);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ww_echo_state') || 'null'));
    checkTrue('入力後に保存が走る', saved && saved.S && saved.S.total_stat === '3000');
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
                && S.total_stat === '2600' && S.crit_rate === '68' && S.crit_dmg === '245',
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

suite('項目別モードでも厳密差分が成立する');
await withPage(async page => {
    const r = await page.evaluate(() => {
        setInputMode('detail', null);
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
            選択肢がbutton: document.querySelectorAll('button.custom-sel-option').length,
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

await finish();
