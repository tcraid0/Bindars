// Runs against the built stylesheet in WebKit, from CI and release verification.
// Return diagnostics instead of throwing so a failure includes all affected states.
(() => {
  const failures = [];
  let checks = 0;
  const check = (ok, message) => { checks++; if (!ok) failures.push(message); };
  const root = document.documentElement;
  const originalTheme = root.getAttribute('data-theme');
  const fixture = document.createElement('article');
  fixture.className = 'markdown-body';
  fixture.style.cssText = 'position:fixed;left:-10000px;top:0;width:600px';
  fixture.innerHTML = '<div class="code-block-wrapper"><pre><code class="hljs"></code></pre></div>';
  // Theme flips must read settled colours, not a transition's first frame.
  const guard = document.createElement('style');
  guard.textContent = '.theme-style-probe, .theme-style-probe * { transition: none !important; }';
  fixture.classList.add('theme-style-probe');
  document.head.append(guard);
  document.body.append(fixture);
  const code = fixture.querySelector('code');
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const rgba = color => {
    context.clearRect(0, 0, 1, 1);
    // An unparsable colour leaves fillStyle unchanged; two sentinels rule out a
    // genuine match with either.
    const parsed = ['#010203', '#030201'].some(sentinel => {
      context.fillStyle = sentinel;
      context.fillStyle = color;
      return context.fillStyle !== sentinel;
    });
    check(parsed, `unparsable colour ${color}`);
    context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data];
  };
  const background = element => {
    if (!element) return [255, 255, 255];
    const [r, g, b, a] = rgba(getComputedStyle(element).backgroundColor);
    const underneath = a === 255 ? [0, 0, 0] : background(element.parentElement);
    return [r, g, b].map((v, i) => v * a / 255 + underneath[i] * (1 - a / 255));
  };
  const luminance = color => color.slice(0, 3).map(v => v / 255)
    .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const ratio = (a, b) => {
    const x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
  };
  const token = name => {
    fixture.style.setProperty('color', `var(--${name})`, 'important');
    return rgba(getComputedStyle(fixture).color);
  };
  const syntax = {
    base: ['hljs-subst', 'hljs-emphasis', 'hljs-strong'],
    comment: ['hljs-comment', 'hljs-quote', 'hljs-code', 'hljs-formula'],
    keyword: ['hljs-keyword', 'hljs-selector-tag', 'hljs-type', 'hljs-doctag', 'hljs-template-tag',
      'hljs-variable language_', 'hljs-name', 'hljs-selector-pseudo'],
    string: ['hljs-string', 'hljs-addition', 'hljs-regexp'],
    number: ['hljs-number', 'hljs-literal'],
    builtin: ['hljs-built_in', 'hljs-title', 'hljs-section', 'hljs-title class_',
      'hljs-title class_ inherited__', 'hljs-title function_'],
    attr: ['hljs-attr', 'hljs-attribute', 'hljs-meta', 'hljs-operator',
      'hljs-selector-attr', 'hljs-selector-class', 'hljs-selector-id'],
    variable: ['hljs-variable', 'hljs-template-variable', 'hljs-symbol', 'hljs-bullet'],
    deletion: ['hljs-deletion'],
  };
  const samples = [];
  for (const [name, classes] of Object.entries(syntax)) {
    for (const className of classes) {
      const span = document.createElement('span');
      span.className = className;
      span.textContent = 'sample ';
      code.append(span);
      samples.push({ span, name });
    }
  }
  for (const name of ['keyword', 'string']) {
    const parent = document.createElement('span');
    parent.className = 'hljs-meta';
    parent.innerHTML = `<span class="hljs-${name}">nested metadata </span>`;
    code.append(parent);
    samples.push({ span: parent.firstChild, name });
  }
  const marked = [];
  for (const color of ['yellow', 'green', 'blue', 'pink']) {
    for (const state of ['annotation', 'search', 'active']) {
      const span = document.createElement('span');
      span.className = 'hljs-comment';
      const annotation = `<mark data-highlight-id="test" class="annotation-highlight-${color}">comment</mark>`;
      span.innerHTML = state === 'annotation' ? annotation
        : `<mark class="search-highlight${state === 'active' ? '-active' : ''}">${annotation}</mark>`;
      code.append(span);
      marked.push({ span: span.querySelector('[data-highlight-id]'), state, color });
    }
  }
  const media = [];
  const collectMedia = rules => {
    for (const rule of rules) {
      if (rule.media && ['print', 'screen'].includes(rule.media.mediaText)) {
        media.push([rule.media, rule.media.mediaText]);
      }
      if (rule.cssRules) collectMedia(rule.cssRules);
    }
  };
  try {
    for (const sheet of document.styleSheets) collectMedia(sheet.cssRules);
    for (const mode of ['screen', 'print']) {
      // Exercise the actual print declarations and cascade without a print dialog.
      // A native print preview remains the layout check.
      for (const [query, original] of media) query.mediaText = original === mode ? 'all' : 'not all';
      for (const theme of ['', 'sepia', 'dark', 'deep-dark']) {
        root.setAttribute('data-theme', theme);
        const label = `${theme || 'light'} ${mode}`;
        for (const { span, name } of samples) {
          const foreground = rgba(getComputedStyle(span).color);
          check(foreground.join() === token(`syntax-${name}`).join(), `${label}: ${span.className} token`);
          const contrast = ratio(foreground, background(span));
          check(contrast >= 4.5, `${label}: ${span.className} contrast ${contrast.toFixed(2)}`);
        }
        for (const { span, state, color } of marked) {
          const style = getComputedStyle(span);
          const foreground = rgba(style.color);
          const contrast = ratio(foreground, background(span));
          check(contrast >= 4.5, `${label}: ${state} ${color} code contrast ${contrast.toFixed(2)}`);
          if (mode === 'screen') {
            check(foreground.join() === token(state === 'active' ? 'on-accent' : 'text-primary').join(),
              `${label}: ${state} ${color} foreground`);
            if (state === 'search') {
              check(rgba(style.backgroundColor)[3] === 0, `${label}: nested ${color} obscures search tint`);
              if (theme !== 'sepia') {
                const shadow = getComputedStyle(span.parentElement).boxShadow;
                const ring = shadow.match(/rgba?\([^)]+\)|color\([^)]+\)/);
                check(!!ring, `${label}: missing search ring`);
                if (ring) {
                  for (const bg of ['bg-primary', 'highlight-blue']) {
                    check(ratio(rgba(ring[0]), token(bg)) >= 3, `${label}: search ring on ${bg}`);
                  }
                }
              }
            }
          } else if (state !== 'annotation') {
            const search = getComputedStyle(span.parentElement);
            check(search.boxShadow === 'none' && search.outlineStyle === 'none', `${label}: search decoration prints`);
          }
        }
      }
    }
  } finally {
    for (const [query, original] of media) query.mediaText = original;
    if (originalTheme === null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', originalTheme);
    fixture.remove();
    guard.remove();
  }
  return JSON.stringify({ checks, failures });
})()
