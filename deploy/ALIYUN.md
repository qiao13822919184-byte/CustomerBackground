# 阿里云单服务器部署

GitHub仓库保存代码，网站需要实际服务器。用户尚未购买服务器时不能把构建成功称为已上线。本项目不会代为购买资源或使用临时隧道冒充长期部署。

## 运行配置

建议先用Linux Ubuntu 24.04、2核与至少2GB内存进行小团队测试；实际内存/并发需压测。公开网页访问情况受服务器地区影响，应在确定套餐前评估模型接口及目标网站的可达性。已有数据服务器不能因部署而重装系统。

1. 在阿里云控制台创建或选择已有ECS/轻量服务器；套餐和付款由账户所有者确认。
2. 安装Git、Docker Engine及Compose插件。安全组和系统防火墙允许公网TCP 80、443；UDP 443用于可选HTTP/3。SSH仅向管理来源开放，应用8787保持仅绑定本机。
3. 确定用户自己的域名，将其A记录指向本机公网IPv4；若存在AAAA记录，也必须指向可达的本机IPv6。确保80/443没有被另一套Web服务器占用。本方案需要真实域名，未选定时不要填示例域名并宣称上线。
4. 在服务器执行：

```sh
sudo mkdir -p /opt/customer-background
sudo chown "$USER:$USER" /opt/customer-background
git clone https://github.com/qiao13822919184-byte/CustomerBackground.git /opt/customer-background
cd /opt/customer-background
cp .env.example .env
chmod 600 .env
# 私下编辑.env，填入API密钥与APP_DOMAIN；不使用本地代理示例。
# APP_DOMAIN只填实际域名，不含https://、端口、路径或尾部斜杠。
sh deploy/production.sh
```

脚本同时使用`compose.yaml`和`compose.production.yaml`，启动应用和独立Caddy容器。Caddy自动申请、续期HTTPS证书并反向代理到`app:8787`；它只收到`APP_DOMAIN`，不会收到API密钥，也不会挂载应用数据卷。应用的`APP_ORIGIN`由覆盖配置统一生成为`https://APP_DOMAIN`，会覆盖`.env`中的手填值，避免浏览器来源不一致导致登录/保存失败。`APP_DOMAIN`为空时Compose直接拒绝执行。

脚本等待容器健康、重载Caddy配置，再通过实际域名验证证书和应用接口。DNS或证书未就绪时会明确失败，容器可能已经启动，可查看`docker compose -f compose.yaml -f compose.production.yaml logs --tail 100 caddy`后重试。该检查来自服务器，最终还需在办公网络浏览器打开链接验收。

5. 读取初始化令牌：`docker compose -f compose.yaml -f compose.production.yaml exec app node -e "console.log(JSON.parse(require('fs').readFileSync('/data/server-secrets.json','utf8')).bootstrap)"`。该命令只应由服务器管理者在私有终端执行，不把输出发到CI或公共聊天中。
6. 浏览器打开实际HTTPS域名，填入令牌、自选管理员用户名与至少12位密码。管理员分配普通账号并测试对应模型后启用。

## 本地模式或已有反向代理

基础`compose.yaml`不启动公网入口，适用于本地开发或已有宿主机Caddy/Nginx的情况。仅使用基础文件时，要自行把`APP_ORIGIN`设为实际访问来源；`deploy/Caddyfile`是宿主机反向代理模板，使用`127.0.0.1:8787`。容器生产方案使用的是独立的`deploy/caddy/Caddyfile`，不能混用地址。现有GitHub部署工作流明确采用容器生产方案，不会静默降为仅本机服务。

## 备份与升级

命名卷 `app_data`保存SQLite数据库、WAL及服务端加密根密钥。生产覆盖配置继续使用这一卷，不会新建另一套应用数据。升级在原目录执行 `git pull --ff-only && sh deploy/production.sh`，保持Compose项目名和目录不变，不删除数据卷。另有`caddy_data`保存TLS证书与私钥，`caddy_config`保存Caddy配置状态，升级时同样保留。

备份必须同时保存数据库和server-secrets.json，否则无法解密管理员配置的API密钥；备份文件仅放私有存储。迁移服务器时也应保留Caddy持久化卷，避免无谓地重新申请证书。

SQLite运行中备份应使用SQLite backup API或停应用后复制完整数据卷，不能只复制主db忽略WAL。定期验证恢复。生产应另行配置自动私有备份。

## GitHub手动部署工作流

可选在仓库的production环境配置 Secrets：`DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KEY`、`DEPLOY_KNOWN_HOSTS`。主机指纹必须由可信渠道确认，SSH用户应只具有应用部署所需权限。API_KEY放服务器.env或管理员加密配置，不需要进入GitHub Actions。

工作流只在手动触发时拉取最新代码并执行`deploy/production.sh`，同时更新应用与HTTPS入口、检查实际HTTPS接口。它要求服务器已有上述首次安装、私有`.env`和域名配置。首次上线后还需从外部浏览器验收真实HTTPS地址、登录、保存与模型测试。缺少服务器、凭据、域名或证书未就绪会明确失败，不会自动购买实例。公开仓库不包含客户资料、真实广告主档案、测试密钥和本地数据库。

配置依据：[Caddy官方Docker镜像及持久化说明](https://hub.docker.com/_/caddy)、[Caddy HTTPS前提](https://caddyserver.com/docs/quick-starts/https)、[Compose必填变量](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)、[Compose环境变量优先级](https://docs.docker.com/compose/how-tos/environment-variables/envvars-precedence/)。当前固定使用官方`caddy:2.11.4-alpine`镜像，后续升级先核查版本再修改。

## 试运行采购配置

初期只需一台轻量应用服务器：通用型、Linux Ubuntu 24.04、2核2GB起、40GB系统盘起、独立公网IPv4、先按月试运行。模型推理由配置的API完成；图片与文档提取主要在浏览器完成，服务器负责协作数据、任务调度和公开网页读取。若同时运行大量任务，应先压测再增加内存与队列容量。

地区需同时测试办公地点访问速度、模型接口和海外搜索可达性；可先评估中国香港或新加坡，但不能保证所有网络路线都可用。套餐是否有货、镜像可选项和实际费用以登录后的购买页为准，不预设自动续费。无需另购云数据库；域名、备份空间和模型调用费用按实际选择计算。

配置与计费参考：[阿里云创建服务器说明](https://help.aliyun.com/zh/simple-application-server/user-guide/create-a-server)、[实例规格族](https://help.aliyun.com/zh/simple-application-server/product-overview/instance-families/)、[计费项](https://help.aliyun.com/zh/simple-application-server/product-overview/billable-items)。
