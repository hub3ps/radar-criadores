import '../testing/env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { feedsDeclarados, normalizarEntrada } from './descoberta.js';

describe('normalizarEntrada', () => {
  test('aceita domínio cru, com www e com esquema', () => {
    assert.equal(normalizarEntrada('deadline.com')?.hostname, 'deadline.com');
    assert.equal(normalizarEntrada('www.deadline.com/')?.hostname, 'www.deadline.com');
    assert.equal(normalizarEntrada('https://deadline.com/feed/')?.pathname, '/feed/');
  });

  test('recusa texto que não é domínio', () => {
    // Ela escreve livremente; "quero o deadline" não pode virar uma URL inventada.
    assert.equal(normalizarEntrada('quero o deadline'), null);
    assert.equal(normalizarEntrada('deadline'), null);
    assert.equal(normalizarEntrada(''), null);
    assert.equal(normalizarEntrada('   '), null);
  });

  test('tira os sinais que o WhatsApp cola em link', () => {
    assert.equal(normalizarEntrada('<deadline.com>')?.hostname, 'deadline.com');
  });
});

describe('feedsDeclarados', () => {
  const base = new URL('https://site.com/');

  test('acha o link alternate de RSS', () => {
    const html = '<link rel="alternate" type="application/rss+xml" href="/feed/">';
    assert.deepEqual(feedsDeclarados(html, base), ['https://site.com/feed/']);
  });

  test('aceita atom e URL absoluta', () => {
    const html = '<link rel="alternate" type="application/atom+xml" href="https://outro.com/atom.xml">';
    assert.deepEqual(feedsDeclarados(html, base), ['https://outro.com/atom.xml']);
  });

  test('ignora alternate que não é feed', () => {
    assert.deepEqual(feedsDeclarados('<link rel="alternate" hreflang="en" href="/en/">', base), []);
    assert.deepEqual(feedsDeclarados('<link rel="stylesheet" href="/a.css">', base), []);
  });

  test('html sem nada devolve lista vazia', () => {
    assert.deepEqual(feedsDeclarados('<html><body>oi</body></html>', base), []);
  });
});
