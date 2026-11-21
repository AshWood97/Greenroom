// The original native service remains responsible for editor ownership and attachment names.
export function patchManagedDownload(patch, java) {
  patch(java + '/compose/service/impl/EpisodeFinalVideoDownloadServiceImpl.java',
    '            connection = openConnection(fullUrl);', `            if ("true".equals(System.getenv("GREENROOM_MANAGED"))
                    && videoUrl.startsWith("/creative-managed/media/")) {
                String assetId = videoUrl.substring("/creative-managed/media/".length());
                if (!assetId.matches("[A-Za-z0-9][A-Za-z0-9_-]*")) throw new ServiceException("成片地址无效");
                // Only the authenticated relay consumes this pointer. It rechecks Asset ownership
                // and streams the canonical bytes; no storage URL or credential enters native AID.
                response.setHeader("X-Greenroom-Managed-Asset", assetId);
                response.setContentType("video/mp4");
                response.setCharacterEncoding(StandardCharsets.UTF_8.name());
                AttachmentDownloadNames.writeAttachmentHeader(response, asciiName, displayName);
                return;
            }
            connection = openConnection(fullUrl);`);
}
