#!/usr/bin/env node
// Why these colours, and what they cost.
//
//   node tools/check-contrast.mjs        # exits 1 if the palette stops meeting the gates below
//
// The row wears one theme-defined ANSI hue per section (SECTION_COLORS in ../statusline.ts, the
// single source of truth — this script imports it, so there is no second copy to drift). Theme
// slots, not hardcoded RGB: a fixed hex holds one background mode and breaks the other, while a
// theme slot is re-tuned by the terminal for its own light or dark palette.
//
// Measured against tools/palettes.json — 811 real terminal themes (see its `source`/`license`).
// The uncomfortable truth it records: NO set of distinct ANSI hues clears WCAG 1.4.3 4.5:1 on
// every theme. Best-balanced by both modes are blue (72% dark / 69% light), purple (73/69) and
// red (65/68); cyan, green, yellow and white are dark-mode specialists. So the palette is chosen
// to maximise the worse mode, and the residual is a limit, not a bug.
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const {ANSI_CODES, SECTION_COLORS} = await import(join(HERE, '..', 'statusline.ts'));
const DATA = JSON.parse(readFileSync(join(HERE, 'palettes.json'), 'utf8'));

// WCAG 2.x relative luminance and contrast ratio, unpadded (2.999:1 does not meet 3:1).
const channel = v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lum = hex => {
	const [r, g, b] = [1, 3, 5].map(i => channel(parseInt(hex.slice(i, i + 2), 16) / 255));
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
	const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
};

const themes = DATA.themes.map(([name, bg, hexes]) => ({name, bg, hexes}));
const dark = themes.filter(t => lum(t.bg) < 0.5);
const light = themes.filter(t => lum(t.bg) >= 0.5);
const rate = (set, slot, threshold) => {
	const i = DATA.slots.indexOf(slot);
	if (i < 0) throw new Error(`unknown slot in palettes.json: ${slot}`);
	const rs = set.map(t => ratio(t.hexes[i], t.bg));
	return rs.filter(r => r >= threshold).length / rs.length;
};

const used = [...new Set(Object.values(SECTION_COLORS))];
const sectionsFor = slot => Object.entries(SECTION_COLORS).filter(([, s]) => s === slot).map(([name]) => name).join(', ');
const pct = n => `${(n * 100).toFixed(0)}%`.padStart(6);

console.log(`themes: ${themes.length} (dark background ${dark.length}, light ${light.length})\n`);
console.log('slot      code   dark 4.5:1   3:1    light 4.5:1   3:1   sections');
for (const slot of used) {
	console.log(
		`${slot.padEnd(9)} ${String(ANSI_CODES[slot]).padEnd(5)} ${pct(rate(dark, slot, 4.5))} ${pct(rate(dark, slot, 3))}    ${pct(rate(light, slot, 4.5))} ${pct(rate(light, slot, 3))}   ${sectionsFor(slot)}`,
	);
}

// The gates. Each one can fail on a plausible mistake, which is the point.
const gates = [];
const check = (ok, label, detail) => gates.push({ok, label, detail});

check(
	!used.includes('brightBlack') && Object.values(ANSI_CODES).every(code => ![2, 90].includes(code)),
	'no faint slot in the palette',
	'ANSI 2 (faint) and brightBlack are where the theme\'s contrast headroom is spent',
);
const weak = used.filter(slot => rate(dark, slot, 3) < 0.5 || rate(light, slot, 3) < 0.5);
check(weak.length === 0, 'every slot clears 3:1 on half of each mode', weak.length ? `weak: ${weak.join(', ')}` : 'the 1.4.11 non-text floor is not being left to chance');
const identity = ['model', 'project'].map(section => SECTION_COLORS[section]);
const unbalanced = identity.filter(slot => rate(dark, slot, 4.5) < 0.65 || rate(light, slot, 4.5) < 0.65);
check(unbalanced.length === 0, 'the identity slots are balanced across both modes', unbalanced.length ? `unbalanced: ${unbalanced.join(', ')}` : 'model and project must be readable on either background');
const states = ['contextOk', 'contextWarning', 'contextDanger', 'counterErrors'].map(s => SECTION_COLORS[s]);
check(new Set(states).size === 3 && states.every(s => ['green', 'yellow', 'red'].includes(s)), 'state colours keep the host\'s own thresholds', 'ok/warning/danger stay green/yellow/red, so the tone still means what it means');

const best = [...DATA.slots].map(slot => ({slot, worst: Math.min(rate(dark, slot, 4.5), rate(light, slot, 4.5))})).sort((a, b) => b.worst - a.worst).slice(0, 3);
console.log(`\nbest any slot can do on both modes: ${best.map(b => `${b.slot} ${(b.worst * 100).toFixed(0)}%`).join(', ')}`);
console.log('colour is never the only cue: every section keeps its own glyph and words.\n');

let failed = 0;
for (const gate of gates) {
	console.log(`  ${gate.ok ? 'PASS' : 'FAIL'}  ${gate.label} — ${gate.detail}`);
	if (!gate.ok) failed += 1;
}
console.log(failed === 0 ? '\nPASS: the palette holds.' : `\nFAIL: ${failed} gate(s).`);
process.exit(failed === 0 ? 0 : 1);
