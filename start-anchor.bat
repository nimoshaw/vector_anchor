@echo off
:: Vector Anchor — HTTP MCP 服务启动脚本
cd /d "D:\projects\vector_anchor"
call npx tsx src/server.ts
