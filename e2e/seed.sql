-- Only this disposable verification schema is reset between runs.
DROP SCHEMA IF EXISTS verify CASCADE;
CREATE SCHEMA verify;
CREATE TABLE verify.users (id integer PRIMARY KEY, name text NOT NULL, email text UNIQUE NOT NULL);
CREATE TABLE verify.orders (id integer PRIMARY KEY, user_id integer REFERENCES verify.users(id), total numeric(10,2) NOT NULL);
INSERT INTO verify.users SELECT n, 'User ' || lpad(n::text, 3, '0'), 'user' || n || '@example.test' FROM generate_series(1, 125) n;
INSERT INTO verify.orders VALUES (1, 1, 19.50), (2, 2, 42);
CREATE VIEW verify.order_totals AS SELECT user_id, sum(total) AS total FROM verify.orders GROUP BY user_id;
