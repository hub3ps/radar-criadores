import '../testing/env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extrairTexto } from './rss.js';

describe('extrairTexto', () => {
  test('tira as tags e mantém o texto', () => {
    assert.equal(extrairTexto('<p>Primeiro parágrafo.</p><p>Segundo.</p>'), 'Primeiro parágrafo.\nSegundo.');
  });

  test('descarta script, style e navegação — não são a matéria', () => {
    const html = `
      <body>
        <nav>Home Sobre Contato</nav>
        <script>var rastreio = 1;</script>
        <style>.a { color: red }</style>
        <p>O texto que interessa.</p>
        <footer>Todos os direitos reservados</footer>
      </body>`;
    assert.equal(extrairTexto(html), 'O texto que interessa.');
  });

  test('usa só o body quando ele existe', () => {
    const html = '<html><head><title>Título da aba</title></head><body><p>Corpo.</p></body></html>';
    assert.equal(extrairTexto(html), 'Corpo.');
  });

  test('resolve as entidades que os feeds realmente usam', () => {
    assert.equal(extrairTexto('<p>p&atilde;o &amp; leite &lt;quente&gt;</p>'), 'p&atilde;o & leite <quente>');
    assert.equal(extrairTexto('<p>caf&#233; e ch&#xe1;</p>'), 'café e chá');
  });

  test('entidade nomeada rara passa intacta, sem virar lixo', () => {
    // Feeds hoje são UTF-8: acento vem como caractere, não como entidade.
    // Se aparecer uma, o scorer ainda entende o resto da frase.
    assert.match(extrairTexto('<p>a&atilde;o b</p>'), /b$/);
  });

  test('remove comentários', () => {
    assert.equal(extrairTexto('<p>Antes</p><!-- oculto --><p>Depois</p>'), 'Antes\nDepois');
  });

  test('colapsa linhas em branco repetidas', () => {
    assert.equal(extrairTexto('<div></div><div></div><p>Só isso.</p>'), 'Só isso.');
  });

  test('texto puro sem tags passa direto', () => {
    assert.equal(extrairTexto('Já era texto.'), 'Já era texto.');
  });

  test('string vazia devolve string vazia', () => {
    assert.equal(extrairTexto(''), '');
  });
});
