#=========================================================================#
# RUI App Template (HTTP) — проксирует домен на Docker-контейнер          #
# __RUI_PORT__ заменяется install-nginx-templates.sh на APP_PORT из .env  #
# DO NOT MODIFY THIS FILE! CHANGES WILL BE LOST WHEN REBUILDING DOMAINS   #
# https://hestiacp.com/docs/server-administration/web-templates.html      #
#=========================================================================#

server {
        listen      %ip%:%proxy_port%;
        server_name %domain_idn% %alias_idn%;
        error_log   /var/log/%web_system%/domains/%domain%.error.log error;

        include %home%/%user%/conf/web/%domain%/nginx.forcessl.conf*;

        location ~ /\.(?!well-known\/|file) {
                deny all;
                return 404;
        }

        # Let's Encrypt HTTP-01 должен работать до включения SSL
        location ^~ /.well-known/acme-challenge/ {
                root       %docroot%;
                default_type "text/plain";
        }

        location / {
                proxy_pass http://127.0.0.1:__RUI_PORT__;

                proxy_http_version 1.1;
                proxy_set_header Host              $host;
                proxy_set_header X-Real-IP         $remote_addr;
                proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
                proxy_set_header X-Forwarded-Proto $scheme;
        }

        location /error/ {
                alias %home%/%user%/web/%domain%/document_errors/;
        }

        include %home%/%user%/conf/web/%domain%/nginx.conf_*;
}
