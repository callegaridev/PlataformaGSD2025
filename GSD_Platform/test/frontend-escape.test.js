const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('dashboard HTML escaping neutralizes markup and attribute delimiters', () => {
  const context = { window: {} };
  const helperPath = path.join(__dirname, '..', 'public', 'gsd-utils.js');
  vm.runInNewContext(fs.readFileSync(helperPath, 'utf8'), context);

  assert.equal(
    context.window.gsdEscapeHtml(`<img src=x onerror="alert(1)"> & '`),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;'
  );
});

test('role dashboards escape names returned by the API before rendering', async () => {
  const payload = '<img src=x onerror=alert(1)>';
  const dashboards = [
    ['public/membro/membros.js', 'carregarArquivos', 'lista-arquivos', [{
      nome_original: payload,
      data_upload: '2025-01-01T00:00:00Z',
      url: '/api/arquivos/1/content'
    }]],
    ['public/coordenador/coordenador.js', 'carregarArquivos', 'lista-arquivos', [{
      nome_original: payload,
      data_upload: '2025-01-01T00:00:00Z',
      url: '/api/arquivos/1/content'
    }]],
    ['public/presidente/presidente.js', 'carregarListaChamada', 'lista-chamada', [{
      id: 1,
      name: payload
    }]]
  ];

  for (const [script, functionName, outputId, apiResponse] of dashboards) {
    const elements = new Map();
    const context = {
      document: {
        addEventListener() {},
        getElementById(id) {
          if (!elements.has(id)) elements.set(id, { innerHTML: '', addEventListener() {} });
          return elements.get(id);
        }
      },
      fetch: async () => ({ ok: true, json: async () => apiResponse }),
      localStorage: { getItem: () => 'Cultura' },
      window: { addEventListener() {}, location: { origin: 'https://gsd.example' } }
    };
    const helperPath = path.join(__dirname, '..', 'public', 'gsd-utils.js');
    const scriptPath = path.join(__dirname, '..', script);
    vm.runInNewContext(fs.readFileSync(helperPath, 'utf8'), context);
    vm.runInNewContext(fs.readFileSync(scriptPath, 'utf8'), context);
    await context[functionName]();

    const rendered = elements.get(outputId).innerHTML;
    assert.ok(rendered.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(!rendered.includes(payload));
  }
});
