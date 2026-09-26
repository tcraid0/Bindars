const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const css = fs.readFileSync(require('node:path').join(__dirname, '../src/app.css'), 'utf8');
const rgb = value => value.replace('#', '').match(/../g).map(v => parseInt(v, 16));
const luminance = color => color.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
const ratio = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
const mix = (fg, bg, alpha) => fg.map((v, i) => v * alpha + bg[i] * (1-alpha));
function paintHighlight(value, base, tokens) {
  if (value.startsWith('#')) return rgb(value);
  const opaque = /^color-mix\(in srgb, (#[\da-f]{6}) ([\d.]+)%, var\(--bg-primary\)\)$/i.exec(value);
  if (opaque) return mix(rgb(opaque[1]), tokens['bg-primary'], Number(opaque[2]) / 100);
  const translucent = /^rgba\(([\d.,\s]+)\)$/.exec(value);
  assert.ok(translucent, `unsupported highlight colour: ${value}`);
  const parts = translucent[1].split(',').map(Number);
  return mix(parts.slice(0, 3), base, parts[3]);
}
for (const theme of ['light', 'sepia', 'dark', 'deep-dark']) {
  test(`${theme}: normal text, accent text, and filled control labels meet 4.5:1 on their surfaces`, () => {
    const selector = theme === 'light' ? ':root' : `[data-theme="${theme}"]`;
    const block = css.slice(css.indexOf(selector + ' {')).split('}')[0];
    const tokens = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[\da-f]{6});/gi)].map(m => [m[1], rgb(m[2])]));
    const backgrounds = ['bg-primary', 'bg-secondary', 'bg-tertiary', 'code-bg'].map(k => tokens[k]);
    backgrounds.push(mix(tokens.accent, tokens['bg-primary'], .15));
    for (const name of ['text-primary','text-secondary','text-muted','accent-text']) {
      for (const bg of backgrounds) assert.ok(ratio(tokens[name], bg) >= 4.5, `${name}: ${ratio(tokens[name],bg)}`);
    }
    for (const fill of ['accent', 'accent-hover']) assert.ok(ratio(tokens['on-accent'], tokens[fill]) >= 4.5, fill);
    // Exercise actual nested highlights, including repeated and mixed colours.
    // Keeping rgba support makes this catch a return to accumulating tint.
    const highlights = [...block.matchAll(/--highlight-(\w+):\s*([^;]+);/g)];
    for (const match of highlights) {
      for (const base of backgrounds) {
        const fill = paintHighlight(match[2], base, tokens);
        for (const name of ['text-primary', 'accent-text']) {
          assert.ok(ratio(tokens[name], fill) >= 4.5, `${name} on ${match[1]} highlight: ${ratio(tokens[name],fill)}`);
          for (const second of highlights) {
            const nested = paintHighlight(second[2], fill, tokens);
            assert.ok(ratio(tokens[name], nested) >= 4.5, `${name} on ${match[1]} + ${second[1]}: ${ratio(tokens[name],nested)}`);
            for (const third of highlights) {
              const triple = paintHighlight(third[2], nested, tokens);
              assert.ok(ratio(tokens[name], triple) >= 4.5, `${name} on three stacked highlights: ${ratio(tokens[name],triple)}`);
            }
          }
        }
      }
    }
    for (const name of ['danger', 'warning']) {
      for (const bg of backgrounds.slice(0,3)) assert.ok(ratio(tokens[name], mix(tokens[name], bg, .1)) >= 4.5, name);
    }
    const editorSearch = mix(tokens.accent, tokens['bg-primary'], .18);
    assert.ok(ratio(tokens['text-primary'], editorSearch) >= 4.5, 'ordinary/current editor search match');
    // Native ::selection (28%) can additionally cover the 18% search background.
    const nativeSelectionOverSearch = mix(tokens.accent, editorSearch, .28);
    assert.ok(ratio(tokens['text-primary'], nativeSelectionOverSearch) >= 4.5, 'native text selection over an editor search match');
  });
}
