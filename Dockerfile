FROM node:lts-alpine
WORKDIR /usr/src/app
COPY package.json package-lock.json* ./
# In a monorepo, we need the workspaces configuration and at least the package.jsons to install correctly
COPY packages/ ./packages/
COPY apps/ ./apps/
RUN npm install

# Now copy the rest and build
COPY . .
RUN apk add --no-cache ffmpeg
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
RUN chown -R node /usr/src/app
USER node
CMD ["npm", "run", "start", "-w", "apps/api"]
