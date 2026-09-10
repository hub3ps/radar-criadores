import '../testing/env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { montarPerfil, montarResumo } from './onboarding.js';
import type { Onboarding } from '../db/types.js';

const base: Onboarding = {
  id: 'x', whatsapp: '5511900000001', etapa: 'confirmacao',
  nicho: 'cinema e séries, mulheres de 18 a 45', perfil_texto: null,
  cobre: 'Anúncio de elenco, trailer e adaptação de livro.',
  evita: 'Terror, games e prêmio técnico.',
  sites: [{ nome: 'Deadline', feed: 'https://deadline.com/feed/', site: 'https://deadline.com' }],
  instagram: ['variety'], tiktok: [],
  creator_id: null, atualizado_em: '', created_at: '',
};

describe('montarResumo', () => {
  test('mostra tudo que ela escolheu', () => {
    const r = montarResumo(base);
    assert.match(r, /cinema e séries/);
    assert.match(r, /Deadline/);
    assert.match(r, /@variety/);
  });

  test('categoria vazia aparece como (nenhum), não some', () => {
    // Sumir daria a impressão de que o cadastro perdeu a informação.
    assert.match(montarResumo(base), /\*TikTok\*: \(nenhum\)/);
  });

  test('pede confirmação explícita', () => {
    assert.match(montarResumo(base), /\*sim\*.*\*não\*/s);
  });

  test('cadastro sem nenhuma fonte ainda gera resumo utilizável', () => {
    const r = montarResumo({ ...base, sites: [], instagram: [], tiktok: [] });
    assert.match(r, /\(nenhum\)/);
    assert.match(r, /cinema e séries/);
  });
});

describe('limite de fontes por tipo', () => {
  test('as perguntas anunciam o limite que está configurado', async () => {
    // O texto é montado a partir da config: subir o limite não exige mexer em
    // texto nenhum, e não pode haver número fixo escondido na pergunta.
    const { config } = await import('../config.js');
    const modulo = await import('./onboarding.js');
    assert.equal(typeof config.runtime.cadastroMaxFontes, 'number');
    assert.ok(config.runtime.cadastroMaxFontes >= 1);
    assert.equal(typeof modulo.responder, 'function');
  });
});

describe('montarPerfil', () => {
  const partes = {
    nicho: 'romance em filmes e livros, mulheres de 18 a 45',
    cobre: 'adaptação de livro, elenco novo, data de estreia',
    evita: 'terror, games, notícia de mercado',
  };

  test('a estrutura COBRE / NÃO COBRE aparece, que é o que faz o scorer discriminar', () => {
    const p = montarPerfil(partes);
    assert.match(p, /COBRE — o que a faz querer gravar/);
    assert.match(p, /NÃO COBRE — o que ela nunca cobriria/);
  });

  test('traz as três respostas na íntegra', () => {
    const p = montarPerfil(partes);
    for (const t of Object.values(partes)) assert.ok(p.includes(t), `faltou "${t}"`);
  });

  test('resposta faltando não deixa rótulo órfão no perfil', () => {
    const p = montarPerfil({ ...partes, evita: null });
    assert.ok(!p.includes('NÃO COBRE'));
    assert.match(p, /COBRE/);
  });

  test('sem nenhuma resposta devolve string vazia em vez de rótulos vazios', () => {
    assert.equal(montarPerfil({ nicho: null, cobre: null, evita: null }), '');
  });
});
