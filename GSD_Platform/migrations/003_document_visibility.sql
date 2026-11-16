ALTER TABLE arquivos
  ADD COLUMN visibilidade TEXT NOT NULL DEFAULT 'geral'
  CHECK (visibilidade IN ('geral', 'gestao'));

CREATE INDEX IF NOT EXISTS arquivos_visibility_date_idx
  ON arquivos(visibilidade, data_upload DESC);
