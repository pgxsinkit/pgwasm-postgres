# contrib/dist.mk
#
# Package each contrib extension into its own .tar.gz archive, reproducibly: the members sorted by name (not
# in the filesystem's directory order), their mtimes at $SOURCE_DATE_EPOCH (not the moment of `make install`),
# owned by root:0, and gzip's header without a name or mtime (tar pipes into gzip).

prefix ?= /pgwasm
CONTRIB_BUILD_ROOT := /tmp/extensions/build
ARCHIVE_DIR := /pgwasm/extensions

CONTRIBS := $(SUBDIRS)

# Default target: build tarballs for all contribs
dist: $(addsuffix .tar.gz,$(CONTRIBS))

# Pattern rule: build $(EXT).tar.gz for each contrib
%.tar.gz:
	@echo "=== Staging $* ==="
	rm -rf $(CONTRIB_BUILD_ROOT)/$*
	bash -c 'mkdir -p $(CONTRIB_BUILD_ROOT)/$*/$(prefix)/{bin,lib,share/extension,share/doc,share/postgresql/extension,share/postgresql/tsearch_data,include}'
	$(MAKE) -C $* install DESTDIR=$(CONTRIB_BUILD_ROOT)/$*
	@echo "=== Packaging $* ==="
	mkdir -p $(ARCHIVE_DIR)
	cd $(CONTRIB_BUILD_ROOT)/$*/$(prefix) && \
	files=$$(find . -type f -o -type l | sed 's|^\./||' | LC_ALL=C sort) && \
	tar --mtime=@$${SOURCE_DATE_EPOCH:?} --owner=root:0 --group=root:0 -czf $(ARCHIVE_DIR)/$*.tar.gz $$files

.PHONY: dist