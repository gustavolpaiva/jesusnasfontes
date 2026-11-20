import { describe, expect, it } from "vitest";
import {
  DATA_AVISO,
  dataPorExtenso,
  hashDoAviso,
  linhaDaVersao,
  MUDANCAS_DO_AVISO,
  mudancasDoAviso,
  secoesDoAviso,
  textoDoAviso,
  VERSAO_AVISO,
} from "@/modules/privacidade/aviso";
import { dataLonga, SESSAO_RECENTE_MS, sessaoRecente } from "@/modules/privacidade/sessao-recente";

const valores = { responsavel: "Responsável de teste", contato: "contato@convite.example" };

describe("aviso de privacidade", () => {
  it("tem os sete blocos do contrato, na ordem, com o responsável e o contato dos valores", () => {
    const secoes = secoesDoAviso(valores);
    expect(secoes.map((s) => s.titulo)).toEqual([
      "Quem cuida dos seus dados",
      "O que guardamos",
      "Isto pode revelar sua crença",
      "Quem lê suas Anotações",
      "Onde ficam os dados",
      "Neste aparelho",
      "Seus direitos",
    ]);
    expect(secoes[0]?.paragrafos[0]).toBe(
      "O responsável é Responsável de teste. Contato: contato@convite.example.",
    );
  });

  it("diz o que a D-08 exige, sem prometer mais privacidade do que ela permite", () => {
    const texto = textoDoAviso(secoesDoAviso(valores));
    expect(texto).toContain("acesso técnico");
    expect(texto).toContain("não são cifradas");
    expect(texto).toContain("quem administra o banco de dados e as contas da hospedagem");
    // Nenhuma promessa absoluta de sigilo.
    expect(texto).not.toMatch(/só você lê|ninguém (pode )?l[êe]|totalmente privad|100 ?%/i);
  });

  it("não afirma onde o e-mail é processado além do que foi medido", () => {
    const texto = textoDoAviso(secoesDoAviso(valores));
    expect(texto).toContain("não garantimos que seu e-mail seja tratado só no Brasil");
    expect(texto).not.toMatch(/e-mails? (ficam|são tratados) (só |apenas )?no Brasil/i);
  });

  it("não usa ponto de exclamação nem os termos proibidos do glossário", () => {
    const texto = textoDoAviso(secoesDoAviso(valores));
    expect(texto).not.toContain("!");
    expect(texto).not.toMatch(/\busuário|\blição|\baula|\bnota\b|\bIA\b|\bbot\b/i);
  });

  it("o hash é estável para o mesmo texto e muda com qualquer palavra", () => {
    const a = hashDoAviso(secoesDoAviso(valores));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDoAviso(secoesDoAviso(valores))).toBe(a);
    expect(hashDoAviso(secoesDoAviso({ ...valores, contato: "outro@convite.example" }))).not.toBe(
      a,
    );
  });

  it("versão, data e linha da versão", () => {
    expect(VERSAO_AVISO).toBe("1");
    expect(dataPorExtenso(DATA_AVISO)).toBe("19 de novembro de 2026");
    expect(linhaDaVersao()).toBe("Aviso versão 1, de 19 de novembro de 2026.");
    expect(() => dataPorExtenso("2026-13-01")).toThrow();
  });

  it("mudanças: a versão atual está registrada e uma tabela injetada vira a lista", () => {
    expect(Object.keys(MUDANCAS_DO_AVISO)).toContain(VERSAO_AVISO);
    expect(mudancasDoAviso("1", { "1": ["Novo prazo das cópias."] })).toEqual([
      "Novo prazo das cópias.",
    ]);
    expect(mudancasDoAviso("9", {})).toEqual([]);
  });
});

describe("sessão recente e data longa", () => {
  const criada = new Date("2026-11-19T12:00:00Z");
  it("recente até 15 minutos, antiga depois", () => {
    expect(SESSAO_RECENTE_MS).toBe(900_000);
    expect(sessaoRecente(criada, new Date(criada.getTime() + 899_999))).toBe(true);
    expect(sessaoRecente(criada, new Date(criada.getTime() + 900_000))).toBe(true);
    expect(sessaoRecente(criada, new Date(criada.getTime() + 900_001))).toBe(false);
  });
  it("data longa no fuso do Brasil", () => {
    expect(dataLonga(new Date("2026-11-19T01:00:00Z"))).toBe("18 de novembro de 2026");
    expect(dataLonga(new Date("2026-11-19T15:00:00Z"))).toBe("19 de novembro de 2026");
  });
});
