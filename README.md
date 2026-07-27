# Painel de Prazos — Unidade Consult

Painel para acompanhar prazos processuais junto ao INPI, organizados por urgência (Muito urgente, Urgente, Médio, Calmo). Os dois usuários da equipe acessam o mesmo endereço e veem as mesmas alterações — sem exportar/importar arquivo.

## Como funciona

- **`public/index.html`** — a interface (estático: HTML, CSS e JavaScript puro, sem build).
- **`server.js`** — um servidor Express pequeno que serve a interface e expõe duas rotas de API:
  - `GET /api/state` — devolve os prazos atuais.
  - `PUT /api/state` — salva os prazos. Se alguém salvou algo mais novo enquanto você editava, devolve `409` com os dados mais recentes em vez de sobrescrever silenciosamente.
- **`seed.json`** — os 32 prazos originais da planilha, usados para popular o banco na primeira vez que o servidor sobe.
- Os dados ficam num banco **PostgreSQL** (uma única linha com todos os prazos em JSON — simples de propósito, dado o volume).
- A página consulta o servidor a cada 20s e também ao voltar para a aba, então uma alteração feita por um usuário aparece para o outro automaticamente, sem precisar recarregar.

## Publicar no Railway

1. **Criar o projeto**: no [railway.app](https://railway.app), `New Project` → `Deploy from GitHub repo` → escolha o repositório `unidadeconsult/PRAZOSUNIDADE` (branch com este código). O Railway detecta que é um projeto Node (via `package.json`) e builda sozinho — não precisa de Dockerfile.

2. **Adicionar o banco de dados**: dentro do projeto no Railway, `New` → `Database` → `Add PostgreSQL`. Isso cria um serviço de banco separado.

3. **Conectar o banco ao serviço do painel**: no serviço do painel (não no banco), abra a aba `Variables` e adicione uma referência à variável `DATABASE_URL` do serviço Postgres (o Railway tem um botão para "Add Reference"/importar variável de outro serviço — selecione o Postgres criado no passo 2). Isso preenche `DATABASE_URL` automaticamente, sem precisar copiar senha na mão.

4. **Definir o login do painel**: ainda na aba `Variables` do serviço do painel, adicione duas variáveis com `New Variable` (valores escolhidos por vocês, não copiem de nenhum exemplo):
   - `APP_USERNAME` — o usuário de acesso.
   - `APP_PASSWORD` — a senha de acesso.

   Sem essas duas variáveis definidas, o painel bloqueia o acesso de todo mundo por segurança (em vez de ficar aberto por engano) — então esse passo não é opcional.

5. **Deploy**: o Railway builda e sobe o serviço automaticamente a cada push nesta branch, e também sempre que uma variável é alterada. Na primeira execução, o servidor cria a tabela e popula com os 32 prazos originais sozinho (não precisa rodar nenhum comando manual).

6. **Gerar o domínio**: na aba `Settings` → `Networking` do serviço do painel, clique em `Generate Domain` para ganhar uma URL pública (ou aponte um domínio próprio, se preferirem).

7. **Conferir**: abra `https://<seu-dominio>/api/health` — deve responder `{"ok":true}` (essa rota não pede login, é só para checagem de saúde do serviço). Depois abra a URL normal — o navegador deve pedir usuário e senha antes de mostrar o painel.

## Rodar localmente (para testar antes de mandar pro Railway)

Requer Node 18+ e um Postgres acessível.

```bash
npm install
export DATABASE_URL="postgres://usuario:senha@localhost:5432/painel_prazos"
export APP_USERNAME="teste"
export APP_PASSWORD="teste"
npm start
# abra http://localhost:3000 (vai pedir usuário/senha)
```

## Sobre o login

O painel usa autenticação HTTP Basic — o próprio navegador mostra a caixa de usuário/senha, sem precisar de tela de login customizada. É um único usuário e senha compartilhado entre os dois usuários (não tem conta individual). Para trocar a senha, basta editar as variáveis `APP_USERNAME`/`APP_PASSWORD` nas Variables do Railway — o serviço reinicia sozinho e passa a valer a nova senha.

## Sobre conflitos entre os dois usuários

Cada salvamento carrega junto a "versão" dos dados que o navegador tinha em mãos. Se as duas pessoas editarem quase ao mesmo tempo, quem salvar por último recebe um aviso e a tela é atualizada com a versão mais recente — a ação que não foi salva simplesmente precisa ser repetida. Isso é intencional: mais simples e mais seguro do que tentar mesclar as duas edições automaticamente.

## Backup manual

Os botões **Exportar** e **Importar** continuam existindo como rede de segurança — não são mais o método principal de compartilhar dados entre os usuários (isso agora é automático), mas servem para guardar uma cópia local de vez em quando ou restaurar o painel a partir de um backup se algo der errado.
