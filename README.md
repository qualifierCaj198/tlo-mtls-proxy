# TLO mTLS Proxy

Dockerized Node.js proxy for TLO PersonSearch SOAP API using mTLS.

## Run

1. Create `.env` with:
   - TLO_USERNAME
   - TLO_PASSWORD
   - SHARED_SECRET

2. Put certs in `secrets/`:
   - tlo_client.crt
   - tlo_client.key

3. Start:
   docker compose up -d --build
