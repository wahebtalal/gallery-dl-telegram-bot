from gallery_dl.extractor.common import Extractor, Message
import os
from urllib.parse import urljoin
import re


class FapopelloExtractor(Extractor):
    """Extractor for fapopello.com (External Version)"""
    category = "fapopello"
    filename_fmt = "{category}_{user}_{post_id}_{index}.{extension}"
    directory_fmt = ("{category}", "{user}")
    pattern = r"https?://(?:www\.)?fapopello\.com/u/[^/]+/[^/]+/(?P<user>[^/?#]+)"
    example = "https://fapopello.com/u/onlyfans/319076/consuelo_hotwife"

    def items(self):
        url = self.url
        user = self.groups[0]
        metadata = self.metadata(user)

        while url:
            self.log.info("Fetching gallery page: %s", url)
            page_data = self.request(url).text

            # Find posts and IDs
            post_links = re.findall(r'href="(/p/(\d+)/[^"]+)"', page_data)

            for path, post_id in post_links:
                post_url = "https://fapopello.com" + path
                yield Message.Directory, None, {"user": user}
                yield from self._extract_post_media(post_url, user, post_id, metadata)

            # Pagination
            next_match = re.search(r'class="next" href="([^"]+)"', page_data)
            if next_match:
                url = "https://fapopello.com" + next_match.group(1)
            else:
                url = None

    def metadata(self, user=None):
        return {"user": user or self.groups[0]}

    def _extract_post_media(self, post_url, user, post_id, metadata):
        post_data = self.request(post_url).text
        body_match = re.search(r'<div class="post-body">(.*?)</div>', post_data, re.DOTALL)
        if not body_match:
            return

        content = body_match.group(1)
        media_urls = re.findall(r'src="([^"]+\.(?:jpg|jpeg|png|mp4|webm|webp))"', content)

        unique_media = []
        for m in media_urls:
            if m not in unique_media:
                unique_media.append(m)

        for index, media_url in enumerate(unique_media):
            media_url = urljoin(post_url, media_url)
            filename, extension = os.path.splitext(media_url)
            extension = extension.lstrip('.')
            data = {
                "user": user,
                "post_id": post_id,
                "index": index,
                "extension": extension,
                "filename": os.path.basename(filename),
            }
            if isinstance(metadata, dict):
                data.update(metadata)
            yield Message.Url, media_url, data
