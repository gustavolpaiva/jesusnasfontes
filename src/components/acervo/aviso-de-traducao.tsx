import { StatusMessage } from "@/components/estado/status-message";

// Aviso de tradução (ACER-04, D-07): a Fonte traduzida por nós ainda não foi revisada por especialista. Pronto
// para quando houver; nesta fase nenhuma Fonte real o dispara. Mesma mensagem na Fonte e na seção.
export function AvisoDeTraducao() {
  return (
    <StatusMessage tipo="informacao">
      Esta tradução foi feita por nós e ainda não foi revisada por especialista. Confira com a
      edição de referência antes de citar.
    </StatusMessage>
  );
}
