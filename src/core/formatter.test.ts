import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatarMensagem, normalizarWhatsapp, tempoRelativo, variantesWhatsapp } from './formatter.js';

const AGORA = new Date('2026-03-10T15:00:00Z');
const atras = (ms: number) => new Date(AGORA.getTime() - ms);

describe('tempoRelativo', () => {
  test('abaixo de um minuto é "agora"', () => {
    assert.equal(tempoRelativo(atras(30_000), AGORA), 'agora');
  });

  test('minutos, horas e dias', () => {
    assert.equal(tempoRelativo(atras(12 * 60_000), AGORA), '12 min');
    assert.equal(tempoRelativo(atras(3 * 3_600_000), AGORA), '3 h');
    assert.equal(tempoRelativo(atras(2 * 86_400_000), AGORA), '2 d');
  });

  test('data no futuro (relógio da fonte adiantado) vira "agora"', () => {
    assert.equal(tempoRelativo(new Date(AGORA.getTime() + 60_000), AGORA), 'agora');
  });
});

describe('formatarMensagem', () => {
  const entrada = {
    delivery: { score: 8, resumo: 'Duas linhas de resumo.\nCom o ponto principal.', gancho: 'O que ninguém te contou.' },
    item: {
      titulo: 'Nubank lança conta internacional',
      url: 'https://site.com/materia',
      publicado_em: atras(12 * 60_000).toISOString(),
      coletado_em: AGORA.toISOString(),
    },
    nomeFonte: 'Valor Econômico',
  };

  test('monta o formato acordado, linha a linha', () => {
    assert.equal(
      formatarMensagem(entrada, AGORA),
      [
        'Valor Econômico · há 12 min',
        '',
        'Duas linhas de resumo.\nCom o ponto principal.',
        '',
        'Gancho: O que ninguém te contou.',
        '',
        'https://site.com/materia',
        '',
        'Responde: 1 = vou gravar · 2 = talvez · 3 = lixo',
      ].join('\n'),
    );
  });

  test('não mostra o título da matéria', () => {
    // É manchete escrita para outro público e atrapalha a leitura do resumo.
    assert.ok(!formatarMensagem(entrada, AGORA).includes('Nubank lança conta internacional'));
  });

  test('não mostra a nota', () => {
    // A nota filtra antes do envio; na mão da criadora ela não serve para nada.
    assert.ok(!/\[\d+\]/.test(formatarMensagem(entrada, AGORA)));
  });

  test('sem publicado_em, usa o momento da coleta', () => {
    const texto = formatarMensagem(
      { ...entrada, item: { ...entrada.item, publicado_em: null } },
      new Date(AGORA.getTime() + 3_600_000),
    );
    assert.match(texto, /há 1 h/);
  });

  test('data inválida não quebra a mensagem', () => {
    const texto = formatarMensagem(
      { ...entrada, item: { ...entrada.item, publicado_em: 'não é data' } },
      AGORA,
    );
    assert.match(texto, /há agora/);
  });

  test('score nulo não quebra a mensagem', () => {
    const texto = formatarMensagem({ ...entrada, delivery: { ...entrada.delivery, score: null } }, AGORA);
    assert.match(texto, /^Valor Econômico/);
  });

  test('a instrução de resposta é sempre a última linha', () => {
    const linhas = formatarMensagem(entrada, AGORA).split('\n');
    assert.equal(linhas.at(-1), 'Responde: 1 = vou gravar · 2 = talvez · 3 = lixo');
  });
});

describe('normalizarWhatsapp', () => {
  test('deixa só dígitos', () => {
    assert.equal(normalizarWhatsapp('+55 (11) 99999-8888'), '5511999998888');
  });
});

describe('variantesWhatsapp', () => {
  test('celular com nono dígito também casa sem ele', () => {
    const v = variantesWhatsapp('5547996489767');
    assert.ok(v.includes('5547996489767'));
    assert.ok(v.includes('554796489767'));
  });

  test('celular sem nono dígito também casa com ele', () => {
    const v = variantesWhatsapp('554796489767');
    assert.ok(v.includes('554796489767'));
    assert.ok(v.includes('5547996489767'));
  });

  test('os dois formatos geram o mesmo conjunto — é o que faz o match funcionar', () => {
    assert.deepEqual(
      [...variantesWhatsapp('5547996489767')].sort(),
      [...variantesWhatsapp('554796489767')].sort(),
    );
  });

  test('aceita número formatado', () => {
    assert.ok(variantesWhatsapp('+55 (47) 99648-9767').includes('5547996489767'));
  });

  test('número estrangeiro passa intacto, sem inventar variante', () => {
    assert.deepEqual(variantesWhatsapp('12025550123'), ['12025550123']);
  });
});
