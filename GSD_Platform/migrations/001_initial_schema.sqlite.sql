CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS migration_runs (
  source_sha256 TEXT PRIMARY KEY,
  table_counts TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('presidente', 'vice-presidente', 'coordenador', 'membro')),
  sector TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_reset_required INTEGER NOT NULL DEFAULT 1,
  photo_path TEXT,
  photo_type TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reunioes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  descricao TEXT NOT NULL,
  data_criacao TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS presencas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reuniao_id INTEGER NOT NULL REFERENCES reunioes(id) ON DELETE CASCADE,
  usuario_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('presente', 'ausente')),
  UNIQUE (reuniao_id, usuario_id)
);

CREATE TABLE IF NOT EXISTS relatorios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,
  projeto TEXT NOT NULL,
  coordenador TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pendente',
  data_envio TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  conteudo TEXT,
  observacao TEXT,
  usuario_email TEXT,
  usuario_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS comissoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('Fixa', 'Temporária')),
  coordenador_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  coordenador_nome TEXT,
  data_criacao TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS membros_comissao (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comissao_id INTEGER NOT NULL REFERENCES comissoes(id) ON DELETE CASCADE,
  usuario_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  nome TEXT NOT NULL,
  email TEXT,
  funcao TEXT
);

CREATE TABLE IF NOT EXISTS tarefas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo TEXT NOT NULL,
  descricao TEXT,
  data_limite TEXT,
  status TEXT NOT NULL DEFAULT 'Pendente',
  tipo_destinatario TEXT CHECK (tipo_destinatario IN ('usuario', 'comissao')),
  destinatario_usuario_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  destinatario_comissao_id INTEGER REFERENCES comissoes(id) ON DELETE SET NULL,
  data_criacao TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (destinatario_usuario_id IS NULL OR destinatario_comissao_id IS NULL)
);

CREATE TABLE IF NOT EXISTS arquivos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome_original TEXT NOT NULL,
  nome_armazenado TEXT NOT NULL,
  tipo TEXT,
  categoria TEXT,
  storage_bucket TEXT,
  object_key TEXT,
  enviado_por INTEGER REFERENCES users(id) ON DELETE SET NULL,
  data_upload TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo TEXT NOT NULL,
  descricao TEXT,
  inicio TEXT NOT NULL,
  fim TEXT,
  tipo TEXT,
  criado_por TEXT,
  data_criacao TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS produtos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  preco NUMERIC NOT NULL CHECK (preco >= 0),
  quantidade INTEGER NOT NULL CHECK (quantidade >= 0)
);

CREATE TABLE IF NOT EXISTS vendas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  produtos TEXT NOT NULL,
  total NUMERIC NOT NULL CHECK (total >= 0),
  valor_recebido NUMERIC NOT NULL CHECK (valor_recebido >= total),
  troco NUMERIC NOT NULL CHECK (troco >= 0),
  data_venda TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  usuario_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS itens_venda (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venda_id INTEGER NOT NULL REFERENCES vendas(id) ON DELETE CASCADE,
  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
  nome_produto TEXT NOT NULL,
  quantidade INTEGER NOT NULL CHECK (quantidade > 0),
  preco_unitario NUMERIC NOT NULL CHECK (preco_unitario >= 0)
);

CREATE TABLE IF NOT EXISTS audios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome_original TEXT NOT NULL,
  nome_armazenado TEXT NOT NULL,
  tipo TEXT,
  descricao TEXT,
  storage_bucket TEXT,
  object_key TEXT,
  enviado_por INTEGER REFERENCES users(id) ON DELETE SET NULL,
  data_upload TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS comunicados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mensagem TEXT NOT NULL,
  data_envio TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  criado_por INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS eventos_radio (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo TEXT NOT NULL,
  inicio TEXT NOT NULL,
  fim TEXT,
  descricao TEXT,
  criado_por INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expire TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX IF NOT EXISTS users_role_sector_idx ON users(role, sector);
CREATE INDEX IF NOT EXISTS presencas_usuario_idx ON presencas(usuario_id);
CREATE INDEX IF NOT EXISTS relatorios_status_date_idx ON relatorios(status, data_envio DESC);
CREATE INDEX IF NOT EXISTS relatorios_usuario_idx ON relatorios(usuario_id);
CREATE INDEX IF NOT EXISTS comissoes_coordenador_idx ON comissoes(coordenador_id);
CREATE INDEX IF NOT EXISTS membros_comissao_usuario_idx ON membros_comissao(usuario_id);
CREATE INDEX IF NOT EXISTS tarefas_usuario_idx ON tarefas(destinatario_usuario_id);
CREATE INDEX IF NOT EXISTS tarefas_comissao_idx ON tarefas(destinatario_comissao_id);
CREATE INDEX IF NOT EXISTS arquivos_date_idx ON arquivos(data_upload DESC);
CREATE INDEX IF NOT EXISTS eventos_inicio_idx ON eventos(inicio);
CREATE INDEX IF NOT EXISTS vendas_date_idx ON vendas(data_venda DESC);
CREATE INDEX IF NOT EXISTS itens_venda_produto_idx ON itens_venda(produto_id);
CREATE INDEX IF NOT EXISTS audios_date_idx ON audios(data_upload DESC);
CREATE INDEX IF NOT EXISTS comunicados_date_idx ON comunicados(data_envio DESC);
CREATE INDEX IF NOT EXISTS eventos_radio_inicio_idx ON eventos_radio(inicio);
CREATE INDEX IF NOT EXISTS sessions_expire_idx ON sessions(expire);
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets(user_id);
