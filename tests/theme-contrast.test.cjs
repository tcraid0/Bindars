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
// These are palette calculations; cascade/mark behaviour is checked in WebKit.
const themes = Object.fromEntries(['light', 'sepia', 'dark', 'deep-dark'].map(theme => {
  const selector = theme === 'light' ? ':root' : `[data-theme="${theme}"]`;
  const start = css.indexOf(selector + ' {');
  assert.ok(start >= 0, `missing ${theme} palette`);
  const block = css.slice(start, css.indexOf('}', start));
  const tokens = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[\da-f]{6});/gi)].map(m => [m[1], rgb(m[2])]));
  for (const [, name, reference] of block.matchAll(/--([\w-]+):\s*var\(--([\w-]+)\);/g)) tokens[name] = tokens[reference];
  const highlights = [...block.matchAll(/--highlight-(\w+):\s*([^;]+);/g)];
  return [theme, { tokens, highlights }];
}));
for (const [theme, { tokens, highlights }] of Object.entries(themes)) {
  test(`${theme}: text, code and filled labels meet 4.5:1, indicators meet 3:1`, () => {
    const backgrounds = ['bg-primary', 'bg-secondary', 'bg-tertiary', 'code-bg'].map(k => tokens[k]);
    backgrounds.push(mix(tokens.accent, tokens['bg-primary'], .15));
    for (const name of ['text-primary','text-secondary','text-muted','accent-text']) {
      for (const bg of backgrounds) assert.ok(ratio(tokens[name], bg) >= 4.5, `${name}: ${ratio(tokens[name],bg)}`);
    }
    for (const bg of backgrounds) {
      assert.ok(ratio(tokens['accent-indicator'], bg) >= 3, `focus/selection indicator: ${ratio(tokens['accent-indicator'],bg)}`);
    }
    for (const fill of ['accent-fill', 'accent-fill-hover']) {
      assert.ok(ratio(tokens['on-accent'], tokens[fill]) >= 4.5, fill);
    }
    // Comments, code spans and formulas share --syntax-comment, so no token is exempt.
    for (const [name, value] of Object.entries(tokens).filter(([key]) => key.startsWith('syntax-'))) {
      assert.ok(ratio(value, tokens['code-bg']) >= 4.5, `${name}: ${ratio(value, tokens['code-bg'])}`);
    }
    // Calculate opaque and nested highlight colours, including mixed colours.
    // Keeping rgba support makes this catch a return to accumulating tint.
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

// Runs index.html's pre-paint script against a minimal document. Without `win`
// it has no window at all, like the most restricted environment.
const bootstrap = /<script>([\s\S]*?)<\/script>/.exec(fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8'))[1];
function runBootstrap(getItem, win) {
  const classes = new Set();
  const root = { style: { setProperty(name, value) { this[name] = value; } }, setAttribute() {}, classList: { add: name => classes.add(name) } };
  require('node:vm').runInNewContext(bootstrap, { document: { documentElement: root }, localStorage: { getItem }, ...(win && { window: win }) });
  return { root, classes };
}

test('bootstrap and swatch backgrounds agree with the theme palettes', () => {
  const swatches = fs.readFileSync(require('node:path').join(__dirname, '../src/components/ReaderControls.tsx'), 'utf8');
  for (const [theme, { tokens }] of Object.entries(themes)) {
    const { root } = runBootstrap(() => theme);
    assert.deepEqual(rgb(root.style.backgroundColor), tokens['bg-primary'], theme);
    assert.deepEqual(rgb(root.style['--ls-bg']), tokens['bg-primary'], theme);
    assert.deepEqual(rgb(root.style['--ls-text']), tokens['text-muted'], theme);
    assert.deepEqual(rgb(root.style['--ls-indicator']), tokens['accent-indicator'], theme);
    const swatch = new RegExp(`value: "${theme}"[^\\n]+bg: "(#[A-Fa-f0-9]{6})"`).exec(swatches);
    assert.deepEqual(rgb(swatch[1]), tokens['bg-primary'], theme);
  }
});

test('bootstrap applies reduced motion from macOS or the saved Reduce effects setting', () => {
  const media = reduce => ({ matchMedia: query => ({ matches: reduce && query.includes('reduced-motion') }) });
  const saved = value => JSON.stringify({ reducedEffects: value });
  const reduced = (records, os = false) => runBootstrap(key => records[key] ?? null, media(os)).classes.has('reduced-motion');
  assert.equal(reduced({}), false, 'nothing set');
  assert.equal(reduced({}, true), true, 'macOS Reduce motion');
  assert.equal(reduced({ 'bindars-settings': saved(true) }), true, 'Reduce effects');
  assert.equal(reduced({ 'markdown-reader-settings': saved(true) }), true, 'legacy record only');
  assert.equal(reduced({ 'bindars-settings': saved(false), 'markdown-reader-settings': saved(true) }), false, 'the current record wins');
  assert.equal(reduced({ 'bindars-settings': '{', 'markdown-reader-settings': saved(true) }), true, 'a damaged current record falls back');
  assert.equal(runBootstrap(() => { throw new Error('denied'); }, media(false)).classes.size, 0, 'storage unavailable');
});

test('bootstrap settings precedence agrees with the reader settings normalizer', () => {
  // Read the real normalizer without requiring a prior workspace-test build.
  const ts = require('typescript');
  const source = fs.readFileSync(require('node:path').join(__dirname, '../src/lib/reader-settings.ts'), 'utf8');
  const exports = {};
  require('node:vm').runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports });
  const { normalizeReaderSettings, DEFAULT_READER_SETTINGS, VALID_FONTS, VALID_SPACINGS } = exports;
  const records = [
    null, '{', 'null', 'false', '42', '"settings"', '[]', '[{"reducedEffects":true}]',
    '{}', '{"unknown":1}', '{"reducedEffects":"true"}', '{"sceneLensEnabled":"false"}',
    '{"fontSize":"18"}', '{"contentWidth":null}', '{"lineHeight":1e400}',
    '{"fontFamily":"unknown"}', '{"paragraphSpacing":"unknown"}',
    JSON.stringify(DEFAULT_READER_SETTINGS),
    ...Object.entries(DEFAULT_READER_SETTINGS).map(([key, value]) => JSON.stringify({ [key]: value })),
    ...VALID_FONTS.map(fontFamily => JSON.stringify({ fontFamily })),
    ...VALID_SPACINGS.map(paragraphSpacing => JSON.stringify({ paragraphSpacing })),
    '{"reducedEffects":true}', '{"sceneLensEnabled":true}',
    '{"fontSize":0}', '{"contentWidth":1000}', '{"lineHeight":-1}',
    '{"fontSize":18,"reducedEffects":"true"}',
  ];
  const legacyRecords = [null, '{', '{}', '{"reducedEffects":false}', '{"reducedEffects":true}'];
  for (const current of records) {
    for (const legacy of legacyRecords) {
      let expected = false;
      for (const raw of [current, legacy]) {
        try {
          const settings = normalizeReaderSettings(JSON.parse(raw));
          if (settings) {
            expected = settings.reducedEffects;
            break;
          }
        } catch {}
      }
      for (const os of [false, true]) {
        const saved = { 'bindars-settings': current, 'markdown-reader-settings': legacy };
        const { classes } = runBootstrap(key => saved[key] ?? null, {
          matchMedia: query => ({ matches: os && query === '(prefers-reduced-motion: reduce)' }),
        });
        assert.equal(classes.has('reduced-motion'), os || expected, JSON.stringify({ current, legacy, os }));
      }
    }
  }
  const { classes } = runBootstrap(key => {
    if (key === 'bindars-settings') throw new Error('unreadable primary record');
    return key === 'markdown-reader-settings' ? '{"reducedEffects":true}' : null;
  }, { matchMedia: () => ({ matches: false }) });
  assert.equal(classes.has('reduced-motion'), true, 'an unreadable primary record must not hide the backup');
});
