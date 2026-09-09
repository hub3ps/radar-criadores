import '../../testing/env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizarRegistro } from './apify.js';
import { extrairHandle } from './base.js';

describe('extrairHandle', () => {
  test('aceita handle cru, com arroba e URL de perfil', () => {
    assert.equal(extrairHandle('fulana'), 'fulana');
    assert.equal(extrairHandle('@fulana'), 'fulana');
    assert.equal(extrairHandle('https://www.instagram.com/fulana/'), 'fulana');
    assert.equal(extrairHandle('https://www.tiktok.com/@fulana'), 'fulana');
    assert.equal(extrairHandle('  @fulana/  '), 'fulana');
  });
});

describe('normalizarRegistro', () => {
  test('lê o formato do apify/instagram-scraper', () => {
    const post = normalizarRegistro(
      {
        url: 'https://www.instagram.com/p/ABC/',
        caption: 'Primeira linha da legenda\nresto do texto',
        ownerUsername: 'fulana',
        timestamp: '2026-03-10T12:00:00.000Z',
      },
      'instagram',
      'fulana',
    );

    assert.equal(post?.url, 'https://www.instagram.com/p/ABC/');
    assert.equal(post?.titulo, 'Primeira linha da legenda');
    assert.equal(post?.texto, 'Primeira linha da legenda\nresto do texto');
    assert.equal(post?.autor, '@fulana');
    assert.equal(post?.publicado_em, '2026-03-10T12:00:00.000Z');
  });

  test('lê o formato do scraptik/tiktok-api, com outros nomes de campo', () => {
    const post = normalizarRegistro(
      {
        webVideoUrl: 'https://www.tiktok.com/@fulana/video/123',
        desc: 'legenda do vídeo',
        authorMeta: { name: 'fulana' },
        createTime: 1_772_000_000,
      },
      'tiktok',
      'fulana',
    );

    assert.equal(post?.url, 'https://www.tiktok.com/@fulana/video/123');
    assert.equal(post?.autor, '@fulana');
    // epoch em segundos vira ISO
    assert.equal(post?.publicado_em, new Date(1_772_000_000_000).toISOString());
  });

  test('epoch em milissegundos também é aceito', () => {
    const post = normalizarRegistro(
      { url: 'https://x/1', createTime: 1_772_000_000_000 },
      'tiktok',
      'fulana',
    );
    assert.equal(post?.publicado_em, new Date(1_772_000_000_000).toISOString());
  });

  test('post sem legenda ganha um título utilizável', () => {
    assert.equal(
      normalizarRegistro({ url: 'https://x/1' }, 'tiktok', 'fulana')?.titulo,
      'Novo post de @fulana no TikTok',
    );
  });

  test('legenda longa é truncada com reticências', () => {
    const post = normalizarRegistro({ url: 'https://x/1', caption: 'a'.repeat(200) }, 'instagram', 'fulana');
    assert.equal(post?.titulo.length, 140);
    assert.ok(post?.titulo.endsWith('…'));
  });

  test('registro sem URL é descartado — sem URL não há dedupe nem link', () => {
    assert.equal(normalizarRegistro({ caption: 'só legenda' }, 'instagram', 'fulana'), null);
  });

  test('data inválida vira null em vez de quebrar', () => {
    assert.equal(
      normalizarRegistro({ url: 'https://x/1', timestamp: 'ontem' }, 'instagram', 'fulana')?.publicado_em,
      null,
    );
  });

  test('sem autor no registro, cai no handle da fonte', () => {
    assert.equal(normalizarRegistro({ url: 'https://x/1' }, 'instagram', 'fulana')?.autor, '@fulana');
  });
});
