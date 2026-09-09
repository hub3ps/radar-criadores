import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  aplicarRegras,
  cooldownTema,
  filtroScore,
  janelaSilencio,
  minutosLocais,
  similaridade,
  tetoDiario,
  tokenizar,
} from './regras.js';

const TZ = 'America/Sao_Paulo';

/** Instante em UTC que corresponde a `hora:minuto` em São Paulo (UTC-3). */
const emSaoPaulo = (hora: number, minuto = 0) =>
  new Date(Date.UTC(2026, 2, 10, hora + 3, minuto));

describe('filtroScore', () => {
  test('desligado, libera qualquer nota', () => {
    assert.equal(filtroScore(0, 7, false).liberado, true);
  });

  test('ligado, barra abaixo do corte e descarta de vez', () => {
    const decisao = filtroScore(4, 7, true);
    assert.equal(decisao.liberado, false);
    assert.equal(decisao.adiar, false);
    assert.match(decisao.motivo ?? '', /abaixo do corte/);
  });

  test('ligado, a nota igual ao corte passa', () => {
    assert.equal(filtroScore(7, 7, true).liberado, true);
  });
});

describe('tetoDiario', () => {
  test('desligado, libera mesmo estourado', () => {
    assert.equal(tetoDiario(50, 5, false).liberado, true);
  });

  test('teto 0 é ilimitado', () => {
    assert.equal(tetoDiario(999, 0, true).liberado, true);
  });

  test('ligado, barra ao atingir o teto e adia', () => {
    const decisao = tetoDiario(5, 5, true);
    assert.equal(decisao.liberado, false);
    assert.equal(decisao.adiar, true);
  });

  test('ligado, libera abaixo do teto', () => {
    assert.equal(tetoDiario(4, 5, true).liberado, true);
  });
});

describe('janelaSilencio', () => {
  test('desligada, libera dentro da janela', () => {
    assert.equal(janelaSilencio(emSaoPaulo(23), '22:00', '07:00', false, TZ).liberado, true);
  });

  test('janela sem virar o dia barra dentro e libera fora', () => {
    assert.equal(janelaSilencio(emSaoPaulo(14), '13:00', '15:00', true, TZ).liberado, false);
    assert.equal(janelaSilencio(emSaoPaulo(16), '13:00', '15:00', true, TZ).liberado, true);
  });

  test('janela que vira o dia cobre os dois lados da meia-noite', () => {
    assert.equal(janelaSilencio(emSaoPaulo(23), '22:00', '07:00', true, TZ).liberado, false);
    assert.equal(janelaSilencio(emSaoPaulo(3), '22:00', '07:00', true, TZ).liberado, false);
    assert.equal(janelaSilencio(emSaoPaulo(12), '22:00', '07:00', true, TZ).liberado, true);
  });

  test('o limite de abertura é fechado e o de fechamento é aberto', () => {
    assert.equal(janelaSilencio(emSaoPaulo(22), '22:00', '07:00', true, TZ).liberado, false);
    assert.equal(janelaSilencio(emSaoPaulo(7), '22:00', '07:00', true, TZ).liberado, true);
  });

  test('sempre adia, nunca descarta', () => {
    assert.equal(janelaSilencio(emSaoPaulo(23), '22:00', '07:00', true, TZ).adiar, true);
  });

  test('janela incompleta ou inválida não barra nada', () => {
    assert.equal(janelaSilencio(emSaoPaulo(23), null, '07:00', true, TZ).liberado, true);
    assert.equal(janelaSilencio(emSaoPaulo(23), '25:99', '07:00', true, TZ).liberado, true);
    assert.equal(janelaSilencio(emSaoPaulo(23), '22:00', '22:00', true, TZ).liberado, true);
  });

  test('aceita HH:MM:SS, que é como o Postgres devolve `time`', () => {
    assert.equal(janelaSilencio(emSaoPaulo(23), '22:00:00', '07:00:00', true, TZ).liberado, false);
  });

  test('o fuso é respeitado, não o do servidor', () => {
    // 01:00 UTC = 22:00 em São Paulo: dentro da janela.
    const meiaNoiteUtc = new Date(Date.UTC(2026, 2, 11, 1, 0));
    assert.equal(janelaSilencio(meiaNoiteUtc, '22:00', '07:00', true, TZ).liberado, false);
    assert.equal(minutosLocais(meiaNoiteUtc, TZ), 22 * 60);
  });
});

describe('cooldownTema', () => {
  const recentes = ['Nubank lança conta internacional para PJ'];

  test('desligado, libera tema repetido', () => {
    assert.equal(cooldownTema('Nubank lança conta internacional para PJ', recentes, false).liberado, true);
  });

  test('ligado, barra a mesma novidade contada por outra fonte', () => {
    const decisao = cooldownTema('Nubank lança nova conta internacional PJ', recentes, true);
    assert.equal(decisao.liberado, false);
    assert.equal(decisao.adiar, false);
  });

  test('ligado, libera assunto diferente', () => {
    assert.equal(cooldownTema('Anvisa aprova novo protetor solar', recentes, true).liberado, true);
  });

  test('sem histórico, libera', () => {
    assert.equal(cooldownTema('Qualquer coisa', [], true).liberado, true);
  });

  test('tokenizar tira acento, pontuação e palavras vazias', () => {
    assert.deepEqual([...tokenizar('A ação da Ambev, no Brasil!')], ['acao', 'ambev', 'brasil']);
  });

  test('similaridade é 1 para o mesmo título e 0 sem interseção', () => {
    assert.equal(similaridade('Preço do café sobe', 'preco do cafe sobe'), 1);
    assert.equal(similaridade('Preço do café', 'Eleição na Bahia'), 0);
  });

  test('título só de palavras vazias não gera falso positivo', () => {
    assert.equal(similaridade('a de o', 'a de o'), 0);
  });
});

describe('aplicarRegras', () => {
  const base = {
    score: 8,
    titulo: 'Item qualquer',
    corteScore: 7,
    tetoDia: 5,
    enviadosHoje: 0,
    janelaInicio: '22:00',
    janelaFim: '07:00',
    titulosRecentes: [] as string[],
    agora: emSaoPaulo(23),
    timeZone: TZ,
  };

  const TODAS_DESLIGADAS = {
    filtroScoreAtivo: false,
    tetoDiarioAtivo: false,
    janelaSilencioAtiva: false,
    cooldownTemaAtivo: false,
  };

  test('fase de calibragem: tudo desligado libera até o pior caso', () => {
    const decisao = aplicarRegras(
      { ...base, score: 0, enviadosHoje: 99, titulosRecentes: ['Item qualquer'] },
      TODAS_DESLIGADAS,
    );
    assert.equal(decisao.liberado, true);
  });

  test('com tudo ligado, o descarte definitivo vem antes do adiamento', () => {
    const decisao = aplicarRegras(
      { ...base, score: 2, enviadosHoje: 99 },
      {
        filtroScoreAtivo: true,
        tetoDiarioAtivo: true,
        janelaSilencioAtiva: true,
        cooldownTemaAtivo: true,
      },
    );
    assert.equal(decisao.liberado, false);
    // Score barrou primeiro: não adianta adiar o que nunca vai passar.
    assert.equal(decisao.adiar, false);
    assert.match(decisao.motivo ?? '', /abaixo do corte/);
  });

  test('nota boa dentro da janela de silêncio é adiada, não descartada', () => {
    const decisao = aplicarRegras(base, { ...TODAS_DESLIGADAS, janelaSilencioAtiva: true });
    assert.equal(decisao.liberado, false);
    assert.equal(decisao.adiar, true);
  });
});
