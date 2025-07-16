# Plataforma GSD - Gestão do Grêmio Estudantil

Sistema completo de gestão para grêmios estudantis, desenvolvido em Node.js com Express e SQLite.

## Funcionalidades

### Para Presidente
- Dashboard com visão geral
- Calendário de eventos
- Registro e gerenciamento de reuniões
- Gestão de comissões
- Atribuição de tarefas
- Upload e compartilhamento de arquivos
- Análise de relatórios
- Ranking de engajamento

### Para Coordenadores
- Dashboard personalizado por setor
- Visualização de arquivos
- Gerenciamento de tarefas
- Participação em comissões
- Envio de relatórios
- Sistema de cantina (setor Finanças)
- Ranking de participação

### Para Membros
- Dashboard com informações relevantes
- Acesso a arquivos compartilhados
- Visualização de tarefas
- Participação em comissões
- Envio de relatórios
- Rádio GSD Mix (membros específicos)
- Ranking geral

## Tecnologias Utilizadas

- **Backend**: Node.js, Express.js
- **Banco de Dados**: SQLite3
- **Frontend**: HTML5, CSS3, JavaScript (Vanilla)
- **Estilização**: Tailwind CSS
- **Upload de Arquivos**: Multer
- **Calendário**: FullCalendar

## Instalação e Configuração

### Pré-requisitos
- Node.js 18+ 
- npm ou yarn

### Instalação
1. Clone o repositório ou extraia os arquivos
2. Instale as dependências:
   ```bash
   npm install
   ```

3. Configure as variáveis de ambiente:
   ```bash
   cp .env.example .env
   ```

4. Inicie o servidor:
   ```bash
   npm start
   ```

### Desenvolvimento
Para desenvolvimento com auto-reload:
```bash
npm run dev
```

## Estrutura do Projeto

```
GSD_Platform/
├── server.js              # Servidor principal
├── package.json           # Dependências e scripts
├── database.db            # Banco de dados SQLite (criado automaticamente)
├── uploads/               # Arquivos enviados
│   └── audios/           # Áudios da rádio
├── public/               # Arquivos estáticos
│   ├── login/           # Tela de login
│   ├── presidente/      # Interface do presidente
│   ├── coordenador/     # Interface dos coordenadores
│   └── membro/          # Interface dos membros
└── README.md            # Este arquivo
```

## Usuários Padrão

O sistema vem com usuários pré-cadastrados para teste:

### Presidente
- **Email**: gabrielcallegari@gsd.com
- **Senha**: senha123

### Vice-Presidente
- **Email**: maxine@gsd.com
- **Senha**: senha123

### Coordenadores
- **Finanças**: mariaeduarda@gsd.com, arthur@gsd.com
- **Eventos**: mavi@gsd.com, estephani@gsd.com
- **Esportes**: isaque@gsd.com, muralha@gsd.com
- **Relações Sociais**: suyane@gsd.com, heloisa@gsd.com
- **Senha**: senha123 (para todos)

### Membros
- **Rádio GSD Mix**: vitoria@gsd.com, yan@gsd.com, wesley@gsd.com
- **Direitos Humanos**: davi@gsd.com, lorrany@gsd.com, isabela@gsd.com
- **Senha**: senha123 (para todos)

## Funcionalidades Especiais

### Sistema de Cantina
Disponível para coordenadores do setor Finanças:
- Cadastro de produtos
- Controle de estoque
- Sistema de vendas (PDV)
- Cálculo automático de troco

### Rádio GSD Mix
Área exclusiva para membros da rádio:
- Upload de áudios e vinhetas
- Escala de programação
- Comunicados internos
- Calendário específico da rádio

### Sistema de Ranking
- Pontuação baseada em presenças e tarefas concluídas
- Ranking geral visível para todos os usuários
- Incentivo ao engajamento

## Configuração para Produção

### Variáveis de Ambiente
```bash
PORT=3000
DATABASE_PATH=./database.db
NODE_ENV=production
```

### Hospedagem
1. Configure o servidor para escutar na porta definida pela variável `PORT`
2. Certifique-se de que o diretório `uploads/` tenha permissões de escrita
3. Configure um proxy reverso (nginx) se necessário
4. Configure SSL/HTTPS para segurança

### Backup do Banco de Dados
O banco SQLite está no arquivo `database.db`. Faça backups regulares:
```bash
cp database.db database_backup_$(date +%Y%m%d).db
```

## Suporte e Manutenção

### Logs
O servidor registra atividades no console. Em produção, redirecione para arquivos:
```bash
npm start > logs/app.log 2>&1
```

### Monitoramento
- Monitore o uso de disco (uploads e banco de dados)
- Verifique logs regularmente
- Mantenha backups atualizados

## Licença

MIT License - Veja o arquivo LICENSE para detalhes.

## Contato

Para suporte técnico ou dúvidas sobre a plataforma, entre em contato com a equipe de desenvolvimento do GSD.

