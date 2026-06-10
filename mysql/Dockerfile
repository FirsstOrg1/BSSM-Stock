FROM mysql:8.0

ENV TZ=Asia/Seoul
ENV MYSQL_ROOT_PASSWORD=q1w2e3
ENV MYSQL_DATABASE=study

COPY ./mysql/conf/my.cnf /etc/mysql/conf.d/my.cnf
COPY ./mysql/init.sql /docker-entrypoint-initdb.d/init.sql

VOLUME ["/var/lib/mysql"]

CMD ["mysqld", "--character-set-server=utf8mb4", "--collation-server=utf8mb4_unicode_ci"]