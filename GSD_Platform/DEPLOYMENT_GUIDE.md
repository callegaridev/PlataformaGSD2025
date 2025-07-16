# Guia de Implantação - Plataforma GSD

Este guia contém todas as informações necessárias para implantar a Plataforma GSD em produção.

## Modificações Realizadas

### 1. URLs Hardcoded Removidas
- ✅ Substituídas todas as URLs `http://localhost:3000` por `window.location.origin`
- ✅ Arquivos modificados:
  - `public/login/login.js`
  - `public/presidente/presidente.js`
  - `public/coordenador/coordenador.js`
  - `public/membro/membros.js`

### 2. Configuração do Banco de Dados
- ✅ Alterado de `:memory:` para arquivo persistente
- ✅ Suporte a variável de ambiente `DATABASE_PATH`
- ✅ Banco padrão: `./database.db`

### 3. Configuração do Servidor
- ✅ Porta configurável via `process.env.PORT`
- ✅ Servidor escuta em `0.0.0.0` para acesso externo
- ✅ CORS habilitado para requisições cross-origin

### 4. Estrutura de Arquivos
- ✅ `package.json` criado com dependências corretas
- ✅ `.env.example` para configuração de ambiente
- ✅ `.gitignore` para controle de versão
- ✅ `README.md` com documentação completa

## Pré-requisitos para Hospedagem

### Servidor
- Node.js 18.0.0 ou superior
- npm ou yarn
- Pelo menos 512MB de RAM
- 1GB de espaço em disco

### Dependências
```json
{
  "express": "^4.18.2",
  "sqlite3": "^5.1.6",
  "cors": "^2.8.5",
  "multer": "^1.4.5-lts.1"
}
```

## Passos para Implantação

### 1. Preparação do Ambiente
```bash
# 1. Faça upload dos arquivos para o servidor
# 2. Instale as dependências
npm install

# 3. Configure as variáveis de ambiente
cp .env.example .env
```

### 2. Configuração das Variáveis de Ambiente
Edite o arquivo `.env`:
```bash
PORT=3000
DATABASE_PATH=./database.db
NODE_ENV=production
```

### 3. Criação de Diretórios
```bash
# Certifique-se de que os diretórios existem
mkdir -p uploads/audios
chmod 755 uploads
chmod 755 uploads/audios
```

### 4. Inicialização
```bash
# Inicie o servidor
npm start

# Ou para desenvolvimento
npm run dev
```

## Configuração de Proxy Reverso (Nginx)

### Exemplo de configuração Nginx:
```nginx
server {
    listen 80;
    server_name seu-dominio.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # Configuração para arquivos estáticos
    location /uploads/ {
        proxy_pass http://localhost:3000/uploads/;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

## Configuração SSL/HTTPS

### Com Certbot (Let's Encrypt):
```bash
# Instale o certbot
sudo apt install certbot python3-certbot-nginx

# Obtenha o certificado
sudo certbot --nginx -d seu-dominio.com

# Configure renovação automática
sudo crontab -e
# Adicione: 0 12 * * * /usr/bin/certbot renew --quiet
```

## Monitoramento e Logs

### 1. Logs da Aplicação
```bash
# Redirecione logs para arquivo
npm start > logs/app.log 2>&1

# Ou use PM2 para gerenciamento
npm install -g pm2
pm2 start server.js --name "gsd-platform"
pm2 logs gsd-platform
```

### 2. Monitoramento de Sistema
```bash
# Monitore uso de recursos
htop
df -h
du -sh uploads/
```

## Backup e Manutenção

### 1. Backup do Banco de Dados
```bash
# Script de backup diário
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
cp database.db "backups/database_$DATE.db"

# Mantenha apenas os últimos 30 backups
find backups/ -name "database_*.db" -mtime +30 -delete
```

### 2. Backup de Uploads
```bash
# Backup dos arquivos enviados
tar -czf "backups/uploads_$(date +%Y%m%d).tar.gz" uploads/
```

### 3. Limpeza de Logs
```bash
# Rotação de logs (adicione ao crontab)
0 0 * * 0 find logs/ -name "*.log" -mtime +7 -delete
```

## Usuários Padrão

### Presidente
- **Email**: gabrielcallegari@gsd.com
- **Senha**: senha123

### Coordenadores
- **Finanças**: mariaeduarda@gsd.com / arthur@gsd.com
- **Eventos**: mavi@gsd.com / estephani@gsd.com
- **Esportes**: isaque@gsd.com / muralha@gsd.com
- **Relações Sociais**: suyane@gsd.com / heloisa@gsd.com
- **Senha**: senha123 (para todos)

### Membros
- **Rádio GSD Mix**: vitoria@gsd.com, yan@gsd.com, wesley@gsd.com
- **Direitos Humanos**: davi@gsd.com, lorrany@gsd.com, isabela@gsd.com
- **Senha**: senha123 (para todos)

## Solução de Problemas

### 1. Erro de Permissões
```bash
# Ajuste permissões dos diretórios
chmod -R 755 public/
chmod -R 755 uploads/
```

### 2. Erro de Banco de Dados
```bash
# Verifique se o arquivo existe e tem permissões
ls -la database.db
chmod 644 database.db
```

### 3. Erro de Porta em Uso
```bash
# Encontre o processo usando a porta
lsof -i :3000
# Mate o processo se necessário
kill -9 <PID>
```

### 4. Problemas de CORS
- Verifique se o CORS está habilitado no servidor
- Confirme que as URLs no frontend usam `window.location.origin`

## Segurança

### 1. Recomendações Básicas
- Altere as senhas padrão imediatamente
- Configure firewall para permitir apenas portas necessárias
- Mantenha o Node.js e dependências atualizados
- Use HTTPS em produção

### 2. Configuração de Firewall
```bash
# UFW (Ubuntu)
sudo ufw allow ssh
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

## Performance

### 1. Otimizações
- Use PM2 para clustering
- Configure cache no Nginx
- Monitore uso de memória e CPU
- Implemente rotação de logs

### 2. Escalabilidade
- Para alta demanda, considere load balancer
- Monitore crescimento do banco de dados
- Implemente limpeza automática de arquivos antigos

## Contato e Suporte

Para questões técnicas sobre a implantação:
- Verifique os logs da aplicação
- Consulte a documentação no README.md
- Entre em contato com a equipe de desenvolvimento

---

**Data de Criação**: $(date)
**Versão da Plataforma**: 1.0.0
**Status**: Pronta para Produção ✅

