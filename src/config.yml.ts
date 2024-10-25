export default `
version: 0.1

log:
  level: debug
  fields:
    service: registry
    environment: development

storage:
  filesystem:
    rootdirectory: {{data}}
  cache:
    blobdescriptor: inmemory
  delete:
    enabled: true
  tag:
    concurrencylimit: 5

http:
  addr: {{addr}}
  headers:
    X-Content-Type-Options: [nosniff]
  # debug:
  #   addr: :5001
  #   prometheus:
  #     enabled: true
  #     path: /metrics
  # tls:
  #   certificate: {{certs}}/domain.crt
  #   key: {{certs}}/domain.key

auth:
  htpasswd:
    realm: basic-realm
    path: {{auth}}/htpasswd
`;
