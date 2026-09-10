# 阿里云单服务器部署

GitHub仓库保存代码，网站需要实际服务器。用户尚未购买服务器时不能把构建成功称为已上线。本项目不会代为购买资源或使用临时隧道冒充长期部署。

## 运行配置

建议先用Linux Ubuntu 24.04、2核与至少2GB内存进行小团队测试；实际内存/并发需压测。公开网页访问情况受服务器地区影响，应在确定套餐前评估模型接口及目标网站的可达性。已有数据服务器不能因部署而重装系统。

1. 在阿里云控制台创建或选择已有ECS/轻量服务器；套餐和付款由账户所有者确认。
2. 安装Git、Docker Engine及Compose。安全组只开放必要的SSH和HTTPS端口；应用8787默认仅绑定本机。
3. 在服务器执行：

```sh
sudo mkdir -p /opt/customer-background
sudo chown "$USER:$USER" /opt/customer-background
git clone https://github.com/qiao13822919184-byte/CustomerBackground.git /opt/customer-background
cd /opt/customer-background
cp .env.example .env
chmod 600 .env
# 编辑.env，填入API密钥及实际HTTPS APP_ORIGIN；不使用本地代理示例。
docker compose up -d --build
```

4. 通过Caddy/Nginx配置HTTPS反向代理至127.0.0.1:8787，`APP_ORIGIN`必须与对外访问来源一致。`deploy/Caddyfile`提供域名模板，域名应归用户所有并已完成所需接入手续。
5. 读取初始化令牌：`docker compose exec app node -e "console.log(JSON.parse(require('fs').readFileSync('/data/server-secrets.json','utf8')).bootstrap)"`。该命令只应由服务器管理者在私有终端执行，不把输出发到CI或公共聊天中。
6. 浏览器打开系统，填入令牌、自选管理员用户名与至少12位密码。管理员分配普通账号并测试对应模型后启用。

## 备份与升级

命名卷 `app_data`保存SQLite数据库、WAL及服务端加密根密钥。升级执行 `git pull --ff-only && docker compose up -d --build`，不删除数据卷。备份必须同时保存数据库和server-secrets.json，否则无法解密管理员配置的API密钥；备份文件仅放私有存储。

SQLite运行中备份应使用SQLite backup API或停应用后复制完整数据卷，不能只复制主db忽略WAL。定期验证恢复。生产应另行配置自动私有备份。

## GitHub手动部署工作流

可选在仓库的production环境配置 Secrets：`DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KEY`、`DEPLOY_KNOWN_HOSTS`。主机指纹必须由可信渠道确认，SSH用户应只具有应用部署所需权限。API_KEY放服务器.env或管理员加密配置，不需要进入GitHub Actions。

工作流只在手动触发时拉取最新代码并更新容器。缺少服务器或凭据会明确失败，不会自动购买实例。公开仓库不包含客户资料、真实广告主档案、测试密钥和本地数据库。
