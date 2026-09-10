import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizarUrl, dedupePorHash, hashUrl, slugDaUrl } from './dedupe.js';

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

describe('slugDaUrl e a republicação sob outra categoria', () => {
  test('extrai o slug do último segmento', () => {
    assert.equal(
      slugDaUrl('https://site.com/series/a-garota-do-remo-netflix-serie-indicacao/'),
      'a-garota-do-remo-netflix-serie-indicacao',
    );
  });

  test('a MESMA matéria sob categorias diferentes tem o mesmo slug', () => {
    // Caso real: a criadora recebeu este item duas vezes, com 5 min de diferença.
    const a = 'https://observatoriodocinema.com.br/cultura-pop/a-garota-do-remo-netflix-serie-indicacao/';
    const b = 'https://observatoriodocinema.com.br/series/a-garota-do-remo-netflix-serie-indicacao/';
    assert.notEqual(hashUrl(a), hashUrl(b), 'as URLs são mesmo diferentes');
    assert.equal(slugDaUrl(a), slugDaUrl(b), 'mas o slug é o mesmo');
  });

  test('matérias diferentes do mesmo assunto continuam distintas', () => {
    assert.notEqual(
      slugDaUrl('https://site.com/criticas/a-garota-do-remo-critica/'),
      slugDaUrl('https://site.com/series/a-garota-do-remo-final-explicado/'),
    );
  });

  test('slug curto demais não serve de identificador', () => {
    assert.equal(slugDaUrl('https://site.com/p/1'), null);
    assert.equal(slugDaUrl('https://site.com/'), null);
  });

  test('dedupePorHash descarta o slug repetido dentro do lote', () => {
    const itens = dedupePorHash([
      { url: 'https://site.com/cultura-pop/a-garota-do-remo-netflix/', titulo: 'primeiro' },
      { url: 'https://site.com/series/a-garota-do-remo-netflix/', titulo: 'republicado' },
      { url: 'https://site.com/series/outra-materia-diferente/', titulo: 'outro' },
    ]);
    assert.equal(itens.length, 2);
    assert.equal(itens[0]?.titulo, 'primeiro');
    assert.equal(itens[1]?.titulo, 'outro');
  });
});
