# Guia de preparação para publicação

Este guia é para você configurar as contas e preparar as informações localmente. **Nenhuma migração remota, publicação, deploy ou envio de código deve ser feito nesta etapa.** Não envie senhas, URLs de conexão ou chaves pelo chat.

## 1. Limites importantes do plano gratuito

Render Free e Supabase Free servem para teste e demonstração, mas não oferecem disponibilidade de produção:

- O Render Free pode suspender o serviço após inatividade, demora para acordar e perde arquivos locais ao reiniciar. A própria documentação recomenda não usar instâncias Free para aplicações de produção.
- O Supabase Free tem cotas de banco, Storage e transferência e pode pausar projetos inativos.
- Os limites e regras dos provedores mudam. Confira os painéis antes de criar projetos ou importar dados.

Use dados de demonstração durante a validação. Não coloque dados pessoais reais de estudantes nesses planos sem avaliar privacidade, segurança, retenção e disponibilidade.

Fontes oficiais: [Render Free](https://render.com/docs/free) e [Supabase Pricing](https://supabase.com/pricing).

## 2. Checklist de variáveis

### Necessárias para o serviço hospedado

| Variável | Valor/origem | Onde configurar |
| --- | --- | --- |
| `NODE_ENV` | `production` | Blueprint do Render já define. |
| `NODE_VERSION` | `22` | Blueprint do Render já define. |
| `PORT` | Atribuída pelo Render. Não fixe um valor. | Render injeta automaticamente. |
| `DATABASE_URL` | URI PostgreSQL do projeto Supabase, com TLS (`sslmode=require`). Contém a senha do banco; trate como segredo. | Render e, temporariamente, ambiente local para o script de migração. |
| `SESSION_SECRET` | Segredo aleatório com pelo menos 32 caracteres. | Blueprint gera um valor; confirme que o Render o criou. |
| `SUPABASE_URL` | URL do projeto Supabase. | Render e ambiente local durante migração de arquivos. |
| `SUPABASE_SERVICE_ROLE_KEY` | No painel atual, prefira a chave **Secret** (`sb_secret_...`); o código recebe o valor por esta variável. A chave legada `service_role` também é privilegiada. Nunca use chave `anon`/publishable aqui nem exponha uma chave de servidor no navegador. | Campo secreto do Render e ambiente local durante migração de arquivos. |

### Opcionais ou locais

| Variável | Quando usar | Padrão/observação |
| --- | --- | --- |
| `SUPABASE_DOCUMENTS_BUCKET` | Somente se mudar o nome do bucket de documentos. | `gsd-documents` |
| `SUPABASE_AUDIOS_BUCKET` | Somente se mudar o nome do bucket de áudio. | `gsd-audios` |
| `SUPABASE_PROFILE_BUCKET` | Somente se mudar o nome do bucket de fotos. | `gsd-profile-photos` |
| `APP_ORIGINS` | Só se o frontend ficar em outro domínio. Use origens exatas, separadas por vírgula. | Deixe vazio quando frontend e API estiverem no mesmo domínio Render. |
| `SOURCE_SQLITE_PATH` | Apenas no computador que executará a migração. Caminho da cópia privada do SQLite. | Se omitido, o script usa `GSD_Platform/database.db`. Prefira informar o caminho da cópia de segurança. |
| `DATABASE_PATH` | Apenas para execução/migração SQLite local. | `./database.local.db`; nunca aponte para o `database.db` original. |
| `LOCAL_UPLOAD_PATH` | Apenas para uploads durante desenvolvimento local. | `./uploads-local`; não é persistente no Render Free. |
| `DB_POOL_SIZE` | Ajuste opcional do pool PostgreSQL. | `5` |
| `MAX_DOCUMENT_BYTES` | Limite opcional para documentos. | `26214400` (25 MiB) |
| `MAX_AUDIO_BYTES` | Limite opcional para áudios. | `52428800` (50 MiB) |
| `MAX_PROFILE_BYTES` | Limite opcional para fotos de perfil. | `5242880` (5 MiB) |

`NODE_VERSION`, `NODE_ENV`, `SESSION_SECRET`, `DATABASE_URL`, `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` já estão previstos em [`render.yaml`](../render.yaml). Os três nomes de bucket acima são os padrões do código e não precisam ser repetidos no Render se forem mantidos.

### Credenciais que você precisará obter

1. **Supabase:** URL do projeto, chave Secret de servidor (ou, se necessário, a chave legada `service_role`) e URI PostgreSQL com a senha do banco.
2. **Render:** conexão à conta GitHub pelo fluxo de autorização do site; não é necessário criar nem compartilhar um GitHub Personal Access Token para este procedimento.
3. **Sessão:** o Render gera `SESSION_SECRET` pelo Blueprint. Não crie uma senha humana para esse campo.

Não é necessário compartilhar nenhuma dessas informações comigo. Guarde a senha do PostgreSQL e a chave de serviço em um gerenciador de senhas; insira-as apenas nos campos oficiais do provedor ou em arquivo local ignorado pelo Git, quando chegarmos à etapa de conexão.

## 3. Criar e preparar o projeto Supabase Free

1. Acesse [Supabase](https://supabase.com/), crie/acesse sua conta e escolha criar um projeto na organização do plano **Free**.
2. Dê um nome ao projeto, selecione uma região próxima e gere uma senha forte e única para o PostgreSQL. Guarde-a no gerenciador de senhas. Não a reutilize em outras contas.
3. Aguarde o projeto ficar disponível. Confira no painel as cotas atuais do Free antes de usar dados reais.
4. No painel do projeto, abra `Connect` e copie a URI PostgreSQL. O endpoint direto do plano Free é IPv6; para um backend persistente em rede IPv4, escolha o **Session pooler** (não Transaction pooler) e copie host, porta e usuário exatamente como exibidos. A aplicação usa conexões persistentes e transações. A URI precisa usar TLS (`sslmode=require`); preserve os parâmetros fornecidos pelo painel. Se o computador usado para migrar não alcançar o endpoint escolhido, pare e ajuste a modalidade de conexão antes de executar qualquer script.
5. Na área de API/Connect, anote localmente a **Project URL** e a chave **Secret** de servidor (`sb_secret_...`). O código lê seu valor da variável `SUPABASE_SERVICE_ROLE_KEY`; isso é apenas o nome da variável, não uma instrução para escolher uma chave pública. A chave legada `service_role` continua privilegiada, mas prefira Secret quando disponível. Nunca coloque nenhuma chave de servidor em HTML, JavaScript público, README ou GitHub.
6. Abra **Storage** e crie estes três buckets com acesso **Private**:
   - `gsd-documents`
   - `gsd-audios`
   - `gsd-profile-photos`
7. Mantenha os buckets privados e não crie políticas abertas para `anon`/usuários não autenticados. Com a chave Secret/service-role, o backend bypassa RLS do Storage; portanto, não há política de bucket que substitua a autorização do Express. As rotas autenticam o usuário e aplicam permissões antes de entregar arquivos. Se no futuro o frontend acessar Storage diretamente, será necessário desenhar e testar políticas RLS específicas antes de habilitar isso.
8. Não faça upload manual de arquivos nem execute SQL de migração nesta fase. Os scripts versionados criam o schema e transferem os objetos depois da aprovação da conexão.

**Política de arquivos da aplicação:** documentos novos podem ser gerais ou restritos à equipe de gestão; áudios são limitados à equipe da rádio; fotos de perfil são servidas por rotas autenticadas. Documentos do SQLite antigo são importados como gerais para preservar o acesso anterior. Buckets continuam privados em todos os casos.

## 4. Preparar o Render sem publicar

1. Acesse [Render](https://render.com/) e crie/acesse sua conta no plano Free.
2. Autorize o acesso do Render ao repositório GitHub `bielizr/PlataformaGSD2025` somente pelo fluxo oficial de autorização. Não envie token do GitHub pelo chat.
3. Confira que o repositório contém `render.yaml` na raiz e que o diretório do projeto é `GSD_Platform`.
4. **Pare antes de criar/aplicar o Blueprint.** Aplicá-lo pode criar o Web Service e iniciar um deploy. Nesta etapa não selecione “Apply”, “Create Web Service” ou “Deploy”.
5. Quando autorizarmos a publicação em uma etapa posterior, o Blueprint configura Node 22, raiz `GSD_Platform`, `npm ci --omit=dev`, `npm start` e health check em `/readyz`. Preencha então `DATABASE_URL`, `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` diretamente no formulário/painel do Render. Confirme que `SESSION_SECRET` foi gerado automaticamente.
6. Não configure `APP_ORIGINS` se interface e API usarem o mesmo domínio. Não configure `DATABASE_PATH` ou `LOCAL_UPLOAD_PATH` em produção.

O health check não prova que a migração terminou corretamente. O Render Free tem filesystem efêmero; o banco deve estar no PostgreSQL e os arquivos nos buckets privados.

## 5. Procedimento seguro para a migração SQLite → PostgreSQL

Este procedimento é para a próxima etapa, **não o execute ainda**.

### A. Backup e preparação local

1. Pare a aplicação antiga ou garanta que ninguém esteja escrevendo no SQLite durante a cópia.
2. Faça uma cópia privada do `database.db` e das pastas `uploads` e `uploads/audios` para uma pasta local protegida. Preserve também o backup original existente. Não coloque essas cópias no repositório, OneDrive público ou chat.
3. Calcule o SHA-256 do banco original e da cópia e confirme que coincidem. Guarde o resultado localmente.
4. Rode `npm test` na versão do código que será migrada. Não continue se os testes falharem.
5. Mantenha `SOURCE_SQLITE_PATH` apontando para a cópia de trabalho, cujo diretório contenha `uploads` e `uploads/audios`. O script de arquivos compara todos os arquivos com os nomes referenciados no SQLite e aborta se encontrar arquivo órfão, referência ausente ou entrada inesperada.

### B. Banco PostgreSQL de destino

1. Confirme que o projeto Supabase escolhido é o destino correto e que ele não contém dados que devam ser preservados. O importador exige tabelas de destino vazias; não mistura nem sobrescreve conteúdo.
2. Configure `DATABASE_URL` e `SOURCE_SQLITE_PATH` somente no ambiente local seguro. O `.env` e `.env.*` são ignorados pelo Git neste projeto; confirme isso com `git check-ignore`. Não publique a URI em comandos copiados, logs, prints ou histórico do terminal.
3. Execute `npm run migrate:sqlite`. O script verifica a integridade SQLite, IDs e e-mails duplicados, referências, valores/totais de vendas e tipos, aplica o schema versionado e importa os dados em transação. As contagens são conferidas antes/depois; uma falha de dados reverte a transação de importação.
4. Compare o resumo de contagens do terminal com o resultado no PostgreSQL. Para verificar contagens do destino, no SQL Editor do Supabase execute:

   ```sql
   SELECT 'users' AS tabela, COUNT(*) AS total FROM users
   UNION ALL SELECT 'reunioes', COUNT(*) FROM reunioes
   UNION ALL SELECT 'presencas', COUNT(*) FROM presencas
   UNION ALL SELECT 'relatorios', COUNT(*) FROM relatorios
   UNION ALL SELECT 'comissoes', COUNT(*) FROM comissoes
   UNION ALL SELECT 'membros_comissao', COUNT(*) FROM membros_comissao
   UNION ALL SELECT 'tarefas', COUNT(*) FROM tarefas
   UNION ALL SELECT 'arquivos', COUNT(*) FROM arquivos
   UNION ALL SELECT 'eventos', COUNT(*) FROM eventos
   UNION ALL SELECT 'produtos', COUNT(*) FROM produtos
   UNION ALL SELECT 'vendas', COUNT(*) FROM vendas
   UNION ALL SELECT 'audios', COUNT(*) FROM audios
   UNION ALL SELECT 'comunicados', COUNT(*) FROM comunicados
   UNION ALL SELECT 'eventos_radio', COUNT(*) FROM eventos_radio
   UNION ALL SELECT 'itens_venda', COUNT(*) FROM itens_venda
   ORDER BY tabela;
   ```

5. Verifique que o histórico de migração registra a origem esperada:

   ```sql
   SELECT source_sha256, table_counts, completed_at
   FROM migration_runs
   ORDER BY completed_at DESC;
   ```

6. Verifique referências órfãs:

   ```sql
   SELECT
     (SELECT COUNT(*) FROM presencas p LEFT JOIN reunioes r ON r.id = p.reuniao_id WHERE r.id IS NULL) AS presencas_sem_reuniao,
     (SELECT COUNT(*) FROM presencas p LEFT JOIN users u ON u.id = p.usuario_id WHERE u.id IS NULL) AS presencas_sem_usuario,
     (SELECT COUNT(*) FROM membros_comissao m LEFT JOIN comissoes c ON c.id = m.comissao_id WHERE c.id IS NULL) AS membros_sem_comissao,
     (SELECT COUNT(*) FROM itens_venda i LEFT JOIN vendas v ON v.id = i.venda_id LEFT JOIN produtos p ON p.id = i.produto_id WHERE v.id IS NULL OR p.id IS NULL) AS itens_venda_orfaos;
   ```

   Todos os resultados devem ser `0`. As demais relações são protegidas pelas chaves estrangeiras do schema.

7. Confirme que as contas importadas exigem redefinição de senha. O migrador descarta as senhas legadas e gera hashes aleatórios Argon2id; elas não permitem login. Não habilite acesso real antes de redefinir as senhas por processo administrativo seguro. O comando local `npm run reset-password -- usuario@exemplo.org` solicita a nova senha sem ecoá-la no terminal e revoga sessões; execute-o somente com a conexão e o usuário corretos.

### C. Storage

1. Só depois de conferir os registros, configure `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` localmente.
2. Execute `npm run migrate:uploads`. O script valida o inventário antes de transferir arquivos, compara SHA-256 do original e do objeto armazenado e só então atualiza a referência no banco.
3. O processo é repetível após falha parcial: ele verifica os objetos já transferidos e valida os bytes. Não apague objetos nem buckets para “tentar de novo”.
4. Confira a tabela de execução da migração de Storage:

   ```sql
   SELECT source_sha256, file_counts, completed_at
   FROM storage_migration_runs
   ORDER BY completed_at DESC;
   ```

### D. Backup e rollback

- Mantenha o SQLite original e a cópia de backup sem alterações. A migração abre o SQLite como somente leitura.
- Antes da migração, mantenha também cópia privada dos dados/arquivos e, após o PostgreSQL ter dados, faça um backup/export independente compatível com as opções disponíveis no plano atual.
- Se a importação de registros falhar, a transação de dados é revertida; o schema versionado pode permanecer no destino vazio. Não apague tabelas manualmente. Confira a causa e repita apenas se o estado/contagens permitirem.
- Se o comando terminar sem resumo por perda de conexão, rode novamente com a mesma cópia. O hash da origem permite reconhecer uma execução completa e validar as contagens; divergências fazem o script falhar em vez de sobrescrever.
- Se a validação falhar ou os dados divergirem, não conecte o Render e não exclua o projeto/banco. Preserve logs sem dados pessoais e pare para avaliar o destino.
- Após a validação, antes de qualquer deploy, exporte também o PostgreSQL para um backup privado e confira que ele pode ser lido/restaurado em um destino isolado. O dump SQL não inclui os objetos do Storage; mantenha o SQLite e a cópia de uploads como backup independente. Não dependa do plano Free como única cópia.
- Antes de uma publicação aprovada, o sistema antigo permanece a opção de retorno, sem escrita simultânea nos dois bancos. Depois de haver novas gravações no PostgreSQL, voltar ao SQLite antigo perderia essas gravações; esse rollback exige plano próprio e interrupção controlada de escrita.

## 6. O que não fazer nesta etapa

- Não envie credenciais pelo chat, e-mail ou issue pública.
- Não torne buckets públicos nem adicione políticas abertas para `anon`.
- Não execute `npm run migrate:sqlite` ou `npm run migrate:uploads` antes de revisar o destino, o backup e as variáveis.
- Não aplique o Blueprint do Render, não publique o repositório e não faça deploy ainda.
- Não remova nem substitua o SQLite original.

## Estado desta etapa

O guia e o Blueprint foram preparados; nenhuma conta ou projeto externo foi criado/modificado, nenhuma credencial foi usada e nenhum deploy/migração remota foi realizado. Após você configurar os projetos, a etapa seguinte será conferir a configuração sem revelar segredos, testar a conexão e então solicitar confirmação antes de iniciar a migração remota.
