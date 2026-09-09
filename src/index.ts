import { pathToFileURL } from 'node:url';
import { schedule, type ScheduledTask } from 'node-cron';
import { collectRss, collectSocial } from './jobs/collect.js';
import { dispatch } from './jobs/dispatch.js';
import { process as processarItens } from './jobs/process.js';
import { iniciarServidor } from './server.js';
import { config } from './config.js';
import { log } from './logger.js';

const logger = log.com({ componente: 'boot' });

// Converte um intervalo em minutos numa expressão de cron:
//   10  -> "*/10 * * * *"
//   60  -> "0 * * * *"
//   120 -> "0 */2 * * *"
// Intervalos que não caem redondo em hora são recusados no boot: um cron errado
// é o tipo de bug que só aparece três dias depois.
export function expressaoCron(minutos: number): string {
  if (minutos < 1) throw new Error(`intervalo inválido: ${minutos}`);
  if (minutos < 60) {
    if (60 % minutos !== 0) {
      throw new Error(`intervalo de ${minutos} min não divide a hora — use 1, 2, 3, 5, 10, 15, 20 ou 30`);
    }
    return `*/${minutos} * * * *`;
  }
  if (minutos % 60 !== 0) {
    throw new Error(`intervalo de ${minutos} min não é múltiplo de 60`);
  }

  const horas = minutos / 60;
  if (horas === 1) return '0 * * * *';
  if (horas < 24 && 24 % horas === 0) return `0 */${horas} * * *`;

  throw new Error(`intervalo de ${minutos} min não vira um cron simples`);
}

/**
 * Rastreia o que está rodando para o encerramento gracioso: em SIGTERM o
 * processo para de agendar e espera o job em andamento terminar antes de sair.
 */
const emAndamento = new Set<Promise<unknown>>();
let encerrando = false;

function agendar(nome: string, expressao: string, tarefa: () => Promise<unknown>): ScheduledTask {
  logger.info('job agendado', { job: nome, cron: expressao, tz: config.runtime.tz });

  return schedule(
    expressao,
    async () => {
      if (encerrando) return;

      const execucao = tarefa().catch((erro: unknown) => {
        // Uma rodada com erro não pode matar o agendamento.
        logger.error('job falhou', { job: nome, erro });
      });

      emAndamento.add(execucao);
      try {
        await execucao;
      } finally {
        emAndamento.delete(execucao);
      }
    },
    {
      name: nome,
      timezone: config.runtime.tz,
      // Se uma rodada demorar mais que o intervalo, a próxima é pulada em vez
      // de rodar em cima da anterior.
      noOverlap: true,
    },
  );
}

function main(): void {
  logger.info('radar-criadores subindo', {
    tz: config.runtime.tz,
    modelo: config.openrouter.modelo,
    dryRunSocial: config.apify.dryRun,
    regras: config.regras,
  });

  if (config.apify.dryRun) {
    logger.warn('SOCIAL_DRY_RUN ligado — Instagram e TikTok não vão raspar nada');
  }

  const servidor = iniciarServidor();

  const tarefas = [
    agendar('collect:rss', expressaoCron(config.cadencia.rssIntervaloMin), collectRss),
    agendar('collect:social', expressaoCron(config.cadencia.socialIntervaloMin), collectSocial),
    // `process` acompanha a cadência do RSS: item coletado precisa ser avaliado
    // logo, senão a vantagem de velocidade se perde na fila.
    agendar('process', expressaoCron(config.cadencia.rssIntervaloMin), processarItens),
    agendar('dispatch', expressaoCron(config.cadencia.dispatchIntervaloMin), dispatch),
  ];

  const encerrar = (sinal: string) => {
    if (encerrando) return;
    encerrando = true;

    logger.info('encerrando', { sinal, jobsEmAndamento: emAndamento.size });

    for (const tarefa of tarefas) void tarefa.stop();
    servidor.close();

    // Espera o que já começou; não deixa um envio pela metade.
    void Promise.allSettled([...emAndamento]).then(() => {
      logger.info('encerrado');
      process.exit(0);
    });

    // Rede travada não pode segurar o container para sempre.
    setTimeout(() => {
      logger.warn('encerramento forçado por timeout');
      process.exit(0);
    }, 30_000).unref();
  };

  process.on('SIGTERM', () => encerrar('SIGTERM'));
  process.on('SIGINT', () => encerrar('SIGINT'));

  process.on('unhandledRejection', (erro) => {
    logger.error('promise rejeitada sem tratamento', { erro });
  });
  process.on('uncaughtException', (erro) => {
    logger.error('exceção não capturada', { erro });
  });
}

// Só sobe o processo quando este arquivo é o entrypoint. Sem a guarda, importar
// qualquer coisa daqui (num teste, por exemplo) subiria servidor e cron.
const ehEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (ehEntrypoint) main();
