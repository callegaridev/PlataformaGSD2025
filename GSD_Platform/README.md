# Plataforma GSD

Sistema de gestão de grêmio estudantil, preservando as áreas e a interface já existentes. A aplicação utiliza Node.js 22, Express, HTML/CSS/JavaScript, PostgreSQL no ambiente hospedado e SQLite para desenvolvimento local.

## Funcionalidades

- Painéis de presidente e vice-presidente, coordenadores e membros.
- Usuários, sessões, redefinição de senha e permissões por função.
- Reuniões, presenças, eventos, comissões, tarefas e relatórios.
- Arquivos compartilhados e fotos de perfil.
- Cantina: produtos, vendas, cálculo de troco e baixa transacional de estoque.
- Rádio GSD Mix: áudios, comunicados e calendário.
- Ranking de participação.

## Tecnologias

- Node.js 22 LTS e Express 5.
- PostgreSQL (`pg`) no servidor; SQLite para execução local.
- Supabase Storage para arquivos persistentes em produção.
- Argon2id e sessões armazenadas no banco.
- Multer para uploads, Helmet, CORS, rate limiting e validação no servidor.
- HTML, CSS e JavaScript sem framework de frontend.

## Requisitos

- Node.js 22.x e npm.
- Para execução local, não é necessário configurar serviços externos.
- Para produção, uma instância PostgreSQL, Supabase Storage e as variáveis de ambiente indicadas abaixo.

## Execução local

No PowerShell, entre na pasta `GSD_Platform`:

```powershell
npm ci
Copy-Item .env.example .env
npm start
```

Abra `http://localhost:3000`. O primeiro início cria `database.local.db`; o banco legado `database.db` não é alterado. O SQLite local e os arquivos locais são ignorados pelo Git.

Para desenvolvimento com reinicialização automática:

```powershell
npm run dev
```

Para rodar a suíte automatizada:

```powershell
npm test
```

O comando `npm run create-admin` cria o primeiro usuário administrador somente se o banco estiver sem usuários. Ele solicita uma senha sem exibi-la no terminal. Não há contas nem senhas padrão.

## Autenticação e migração de contas antigas

Senhas novas são armazenadas com Argon2id. As contas importadas do SQLite ficam bloqueadas até uma redefinição segura; as senhas legadas não são aceitas como credenciais de produção.

Para redefinir a senha de uma conta usando o banco configurado no `.env`:

```powershell
npm run reset-password -- usuario@exemplo.org
```

Use um terminal interativo. O comando revoga as sessões ativas da plataforma.

Para criar uma cópia local de desenvolvimento com os dados do banco legado, mantenha `database.db` e as pastas `uploads` ao lado do arquivo e execute:

```powershell
npm run migrate:sqlite:local
npm run migrate:uploads:local
```

Esses comandos criam `database.local.db` e `uploads-local` sem alterar o banco original. Contas importadas continuam exigindo redefinição de senha.

## Variáveis de ambiente

Copie `.env.example` para `.env` localmente. Em produção, configure os valores no painel do provedor, nunca em arquivos versionados:

| Variável | Finalidade |
| --- | --- |
| `NODE_ENV` | Use `production` no servidor. |
| `PORT` | Porta HTTP; fornecida pelo Render. |
| `DATABASE_URL` | URL PostgreSQL com conexão TLS. Obrigatória em produção. |
| `SESSION_SECRET` | Segredo aleatório de sessão com pelo menos 32 caracteres. |
| `SUPABASE_URL` | URL do projeto Supabase. |
| `SUPABASE_SERVICE_ROLE_KEY` | Variável do backend para a chave Secret do Supabase (`sb_secret_...`; a chave legada `service_role` também funciona). Mantenha privada; nunca use no frontend. |
| `SUPABASE_DOCUMENTS_BUCKET` | Bucket privado de documentos; padrão `gsd-documents`. |
| `SUPABASE_AUDIOS_BUCKET` | Bucket privado de áudios; padrão `gsd-audios`. |
| `SUPABASE_PROFILE_BUCKET` | Bucket privado de fotos; padrão `gsd-profile-photos`. |
| `APP_ORIGINS` | Origens adicionais permitidas pelo CORS, separadas por vírgula. |
| `DATABASE_PATH` | Caminho opcional do SQLite local; não pode apontar para o banco legado. |
| `SOURCE_SQLITE_PATH` | Caminho privado do SQLite legado, usado apenas pelos scripts de migração. |
| `LOCAL_UPLOAD_PATH` | Caminho local para uploads durante desenvolvimento. |

O armazenamento local não é adequado para produção em serviços com disco efêmero. Crie os três buckets no Supabase como **privados**; o backend autentica as requisições e entrega os arquivos protegidos.

Documentos novos podem ser marcados como disponíveis para todos os usuários ou somente para a equipe de gestão (presidente, vice-presidente e coordenadores). Documentos importados e existentes permanecem com acesso geral para preservar o comportamento anterior. Áudios continuam restritos à equipe da rádio.

## Limites dos planos gratuitos

Render Free e Supabase Free permitem testar e demonstrar a aplicação sem custo, mas não garantem uma operação contínua de produção. Conforme a documentação consultada em 13/11/2026, o Render encerra serviços web gratuitos após 15 minutos sem tráfego, pode levar cerca de um minuto para reativá-los, descarta arquivos locais ao reiniciar e declara que o plano gratuito não deve hospedar aplicações de produção. O limite de horas gratuitas do workspace também pode suspender os serviços quando esgotado.

O Supabase Free inclui atualmente até 500 MB de banco e 1 GB de arquivos, e pode pausar projetos sem atividade por uma semana. Esses limites, cotas de transferência e política de backups podem mudar; confira os painéis antes de importar dados. Portanto, use a configuração gratuita para validação/portfólio com dados de demonstração e sem informações pessoais reais. Uma operação pública com disponibilidade e dados reais requer aceitar essas limitações ou escolher um plano com garantias adequadas.

Referências oficiais: [limites do Render Free](https://render.com/docs/free) e [preços e cotas do Supabase](https://supabase.com/pricing).

## Migração do banco legado

1. Faça e valide um backup privado do `database.db`; nunca o adicione ao Git.
2. Crie um PostgreSQL vazio e configure `DATABASE_URL` e as credenciais do Supabase no `.env` local ou no ambiente seguro.
3. Configure `SOURCE_SQLITE_PATH` para a cópia protegida do banco e execute `npm run migrate:sqlite`.
4. O importador verifica integridade, IDs e e-mails duplicados, referências, valores de vendas, contagens e destino vazio; a importação ocorre em transação e pode ser repetida com segurança para a mesma origem.
5. Com o mesmo `SOURCE_SQLITE_PATH`, os diretórios legados `uploads` e `uploads/audios` ao lado do banco e as credenciais privadas do Supabase disponíveis, execute `npm run migrate:uploads`. Antes de enviar qualquer arquivo, o script compara o inventário local com as referências do SQLite e interrompe a operação se houver arquivos sem referência ou referências ausentes. Depois, confere os hashes dos bytes enviados e pode ser repetido após uma falha parcial.
6. Redefina as senhas migradas antes de habilitar o acesso às contas.

O importador do banco não copia os bytes dos uploads legados; a transferência ocorre no comando separado acima. Não faça o deploy até que os arquivos existentes tenham sido transferidos e verificados no Storage.

## Preparação Render e Supabase

O Blueprint [`../render.yaml`](../render.yaml) define a raiz `GSD_Platform`, Node.js 22, comando de inicialização e health check. `DATABASE_URL`, `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` devem ser fornecidas no painel do Render. O Blueprint gera um segredo de sessão aleatório.

Os planos gratuitos podem suspender serviços, impor limites de armazenamento/uso e não oferecer garantias de backup ou disponibilidade. Faça backups independentes do banco e valide limites e retenção atuais dos provedores antes de usar dados reais. O filesystem do serviço web não é persistente; os arquivos da aplicação ficam no Storage.

Antes de criar os recursos, consulte o [guia de preparação para publicação](./DEPLOYMENT_GUIDE.md), que lista as variáveis, a configuração dos buckets privados e o procedimento de migração/rollback. Não aplique o Blueprint até estar pronto para iniciar um deploy.

## Estado da implantação

O código de autenticação, os schemas iniciais e o importador de banco estão preparados e testados localmente. Ainda é necessário validar a conexão com PostgreSQL/Supabase reais e concluir/verificar a transferência dos arquivos legados antes de qualquer publicação. Nenhum deploy público foi realizado.
