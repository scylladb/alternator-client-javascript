SHELL := bash
.ONESHELL:
.SHELLFLAGS := -eo pipefail -c

MAKEFILE_PATH := $(abspath $(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
SCYLLA_SOURCE_IMAGE := scylladb/scylla:2025.1@sha256:07f68389d5bb05c5647662a81f78ad6d5fa44d3fbb7bb54a8c060dac8a4f6561
SCYLLA_CACHE_IMAGE := alternator-client-cache/scylla:2025.1-07f68389
SCYLLA_AMD64_IMAGE_ID := sha256:3388da7b9cfcd226564a23da9f58750cd42daea28231144f32ff51b8c836d9d4
SCYLLA_ARM64_IMAGE_ID := sha256:63d041d89d5f2fb4f56766c0df18a0c424ba425528bd76b05c230e60fb7a6542
COMPOSE := SCYLLA_IMAGE=$(SCYLLA_CACHE_IMAGE) docker compose -f $(MAKEFILE_PATH)/test/docker-compose.yml

DOCKER_CACHE_DIR := $(MAKEFILE_PATH)/.docker-cache
DOCKER_CACHE_FILE := $(DOCKER_CACHE_DIR)/scylla-image.tar
CERT_CACHE_DIR := $(MAKEFILE_PATH)/.cert-cache
CERT_DIR := $(MAKEFILE_PATH)/test/scylla

.PHONY: clean verify lint lint-fix test-unit test-integration test-all wait-for-alternator scylla-start scylla-stop scylla-kill scylla-rm docker-pull docker-cache-save docker-cache-load verify-docker-image cert-cache-save cert-cache-load

clean:
	rm -rf dist

verify:
	npm run verify

lint:
	npm run lint

lint-fix:
	npm run lint -- --fix

test-unit:
	npm test

wait-for-alternator:
	@echo "Waiting for Alternator to be ready..."
	@for i in $$(seq 1 60); do \
		if curl -sf http://172.39.0.2:9998/ >/dev/null 2>&1; then \
			echo "Alternator is ready (waited $${i}s)"; \
			break; \
		fi; \
		if [ $$i -eq 60 ]; then \
			echo "Timed out waiting for Alternator"; \
			$(MAKE) scylla-stop; \
			exit 1; \
		fi; \
		sleep 1; \
	done

test-integration: scylla-start wait-for-alternator
	INTEGRATION_TESTS=true \
	ALTERNATOR_HOST=172.39.0.2 \
	ALTERNATOR_PORT=9998 \
	ALTERNATOR_HTTPS_PORT=9999 \
	ALTERNATOR_CA_CERT_PATH=$$(pwd)/test/scylla/db.crt \
	npm run test:integration || ($(MAKE) scylla-stop && exit 1)
	$(MAKE) scylla-stop

test-all: test-integration

.prepare-environment-update-aio-max-nr:
	@if (( $$(< /proc/sys/fs/aio-max-nr) < 2097152 )); then \
		echo 2097152 | sudo tee /proc/sys/fs/aio-max-nr >/dev/null; \
	fi

.prepare-docker-compose:
	@docker compose version >/dev/null

.prepare-cert:
	@[ -f "$(CERT_DIR)/db.key" ] || ( \
		echo "Prepare certificate" && \
		mkdir -p "$(CERT_DIR)" && \
		cd "$(CERT_DIR)" && \
		openssl req -subj "/C=US/ST=Denial/L=Springfield/O=Dis/CN=www.example.com" -x509 -newkey rsa:4096 -keyout db.key -out db.crt -days 3650 -nodes -addext "subjectAltName=IP:172.39.0.2,IP:172.39.0.3,IP:172.39.0.4" && \
		chmod 644 db.key \
	)

scylla-start: cert-cache-load .prepare-docker-compose .prepare-environment-update-aio-max-nr docker-cache-load
	$(COMPOSE) up -d --pull never

scylla-stop: .prepare-docker-compose
	$(COMPOSE) down

scylla-kill: .prepare-docker-compose
	$(COMPOSE) kill

scylla-rm: .prepare-docker-compose
	$(COMPOSE) rm -f

docker-pull:
	docker pull $(SCYLLA_SOURCE_IMAGE)
	docker tag $(SCYLLA_SOURCE_IMAGE) $(SCYLLA_CACHE_IMAGE)
	$(MAKE) verify-docker-image

docker-cache-save: docker-pull
	@mkdir -p $(DOCKER_CACHE_DIR)
	docker save $(SCYLLA_CACHE_IMAGE) -o $(DOCKER_CACHE_FILE)

docker-cache-load:
	@if [ -f "$(DOCKER_CACHE_FILE)" ]; then \
		echo "Loading Docker image from cache..."; \
		docker load -i "$(DOCKER_CACHE_FILE)"; \
		$(MAKE) verify-docker-image; \
	else \
		echo "Cache file not found, pulling image..."; \
		$(MAKE) docker-pull; \
	fi

verify-docker-image:
	@architecture=$$(docker image inspect --format '{{.Architecture}}' $(SCYLLA_CACHE_IMAGE)); \
	image_id=$$(docker image inspect --format '{{.Id}}' $(SCYLLA_CACHE_IMAGE)); \
	case "$$architecture" in \
		amd64) expected_id=$(SCYLLA_AMD64_IMAGE_ID) ;; \
		arm64) expected_id=$(SCYLLA_ARM64_IMAGE_ID) ;; \
		*) echo "Unsupported cached ScyllaDB image architecture: $$architecture"; exit 1 ;; \
	esac; \
	if [ "$$image_id" != "$$expected_id" ]; then \
		echo "Cached ScyllaDB image ID mismatch for $$architecture"; \
		echo "Expected: $$expected_id"; \
		echo "Actual:   $$image_id"; \
		exit 1; \
	fi

cert-cache-save: .prepare-cert
	@mkdir -p $(CERT_CACHE_DIR)
	cp $(CERT_DIR)/db.key $(CERT_DIR)/db.crt $(CERT_CACHE_DIR)/

cert-cache-load:
	@if [ -f "$(CERT_CACHE_DIR)/db.key" ] && [ -f "$(CERT_CACHE_DIR)/db.crt" ]; then \
		echo "Loading certificates from cache..."; \
		mkdir -p "$(CERT_DIR)"; \
		cp "$(CERT_CACHE_DIR)/db.key" "$(CERT_CACHE_DIR)/db.crt" "$(CERT_DIR)/"; \
		chmod 644 "$(CERT_DIR)/db.key"; \
	else \
		echo "Certificate cache not found, generating..."; \
		$(MAKE) .prepare-cert; \
	fi
