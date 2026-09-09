import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizarUrl, dedupePorHash, hashUrl } from './dedupe.js';

describe('canonicalizarUrl', () => {
  test('remove parâmetros de rastreamento', () => {
    assert.equal(
      canonicalizarUrl('https://site.com/materia?utm_source=x&utm_medium=y&id=7'),
      'https://site.com/materia?id=7',
    );
  });

  test('remove fragmento, www, barra final e porta padrão', () => {
    assert.equal(canonicalizarUrl('https://www.site.com:443/materia/#topo'), 'https://site.com/materia');
  });

  test('ordena os parâmetros que sobram', () => {
    assert.equal(
      canonicalizarUrl('https://site.com/x?b=2&a=1'),
      canonicalizarUrl('https://site.com/x?a=1&b=2'),
    );
  });

  test('a raiz do domínio não perde o host', () => {
    assert.equal(canonicalizarUrl('https://site.com/'), 'https://site.com');
  });

  test('preserva maiúsculas do caminho, que é sensível a caixa', () => {
    assert.equal(canonicalizarUrl('https://SITE.com/Materia'), 'https://site.com/Materia');
  });

  test('string que não é URL passa aparada, sem quebrar', () => {
    assert.equal(canonicalizarUrl('  @fulana  '), '@fulana');
  });
});

describe('hashUrl', () => {
  test('a mesma matéria por dois caminhos gera o mesmo hash', () => {
    assert.equal(
      hashUrl('https://www.site.com/materia?utm_source=twitter'),
      hashUrl('https://site.com/materia/'),
    );
  });

  test('matérias diferentes geram hashes diferentes', () => {
    assert.notEqual(hashUrl('https://site.com/a'), hashUrl('https://site.com/b'));
  });

  test('é sha256 em hex', () => {
    assert.match(hashUrl('https://site.com/a'), /^[0-9a-f]{64}$/);
  });
});

describe('dedupePorHash', () => {
  test('a primeira ocorrência vence dentro do mesmo lote', () => {
    const itens = dedupePorHash([
      { url: 'https://site.com/a', titulo: 'primeiro' },
      { url: 'https://www.site.com/a/?utm_source=x', titulo: 'duplicado' },
      { url: 'https://site.com/b', titulo: 'outro' },
    ]);

    assert.equal(itens.length, 2);
    assert.equal(itens[0]?.titulo, 'primeiro');
    assert.equal(itens[1]?.titulo, 'outro');
  });

  test('anexa url_hash em cada item', () => {
    const [item] = dedupePorHash([{ url: 'https://site.com/a' }]);
    assert.equal(item?.url_hash, hashUrl('https://site.com/a'));
  });
});
