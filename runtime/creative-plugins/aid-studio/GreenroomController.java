package com.aid.greenroom;
import com.aid.common.core.domain.AjaxResult;
import com.aid.common.utils.SecurityUtils;
import java.util.*;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/greenroom")
public class GreenroomController {
    private final GreenroomQueue queue;
    private final GreenroomCompose compose;
    public GreenroomController(GreenroomQueue queue,GreenroomCompose compose) { this.queue=queue; this.compose=compose; }
    @com.aid.common.annotation.Anonymous
    @GetMapping("/health")
    public AjaxResult health() { queue.health(); return AjaxResult.success(); }
    @GetMapping("/pending")
    public AjaxResult pending(@RequestParam(value="after",required=false) String after) { return AjaxResult.success(queue.pending(SecurityUtils.getUserId(),after)); }
    @PostMapping("/task-update")
    public AjaxResult update(@RequestBody Map<String,Object> value) { queue.update(SecurityUtils.getUserId(),value); return AjaxResult.success(); }
    @PostMapping("/models")
    public AjaxResult models(@RequestBody Map<String,List<Map<String,Object>>> catalog) { queue.syncModels(catalog); return AjaxResult.success(); }
    @PostMapping("/compose/{id}/run")
    public AjaxResult run(@PathVariable String id,@RequestBody Map<String,List<String>> input) { return AjaxResult.success(compose.start(SecurityUtils.getUserId(),id,input)); }
    @GetMapping("/compose/{id}/status")
    public AjaxResult status(@PathVariable String id) { return AjaxResult.success(compose.status(SecurityUtils.getUserId(),id)); }
    @com.aid.common.aid.crypto.annotation.CryptoIgnore
    @GetMapping("/compose/{id}/output")
    public org.springframework.http.ResponseEntity<org.springframework.core.io.Resource> output(@PathVariable String id) {
        return org.springframework.http.ResponseEntity.ok().contentType(org.springframework.http.MediaType.valueOf("video/mp4"))
            .cacheControl(org.springframework.http.CacheControl.noStore())
            .body(new org.springframework.core.io.FileSystemResource(compose.download(SecurityUtils.getUserId(),id)));
    }
}
