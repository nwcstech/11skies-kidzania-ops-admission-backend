FROM node:14

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

RUN ls -la /usr/src/app/models

EXPOSE 4000

ENV NODE_ENV=production

CMD [ "node", "server.js" ]