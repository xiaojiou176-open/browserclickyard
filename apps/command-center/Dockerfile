FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts ./scripts
COPY apps/command-center ./apps/command-center
RUN corepack enable && corepack prepare pnpm@10.22.0 --activate && pnpm install --frozen-lockfile
WORKDIR /app/apps/command-center
RUN UIQ_NODE_MODULES_DIR=/app/node_modules pnpm build

FROM nginx:1.27-alpine
COPY apps/command-center/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/command-center/dist /usr/share/nginx/html
USER nginx
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
