package com.aid.greenroom;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.aid.common.exception.ServiceException;
import com.aid.compose.domain.ComposeJobPlan;
import com.aid.media.provider.impl.LocalFfmpegVideoProviderClient;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import org.springframework.stereotype.Service;

@Service
public class GreenroomCompose {
    private final GreenroomQueue queue;
    private final LocalFfmpegVideoProviderClient renderer;
    private final Map<String,CompletableFuture<Void>> running=new ConcurrentHashMap<>();
    private final Path root=Path.of(Objects.requireNonNullElse(System.getenv("GREENROOM_PLUGIN_ROOT"),"/data/aid"),"compose").toAbsolutePath();
    public GreenroomCompose(GreenroomQueue queue,LocalFfmpegVideoProviderClient renderer) { this.queue=queue; this.renderer=renderer; }
    private Path output(Long owner,String id) {
        queue.owned(owner,id);
        return root.resolve(owner.toString()).resolve(id.replace(":","-")+".mp4");
    }
    public Map<String,Object> status(Long owner,String id) {
        Path path=output(owner,id);
        if(Files.isRegularFile(path)) return Map.of("status","ready","downloadPath","/greenroom/compose/"+id+"/output");
        JSONObject task=queue.result(id);
        if("failed".equals(task.getString("status"))) return Map.of("status","failed","error",Objects.toString(task.get("error"),"合成失败"));
        return Map.of("status",running.containsKey(id)?"processing":"pending");
    }
    public synchronized Map<String,Object> start(Long owner,String id,Map<String,List<String>> request) {
        Map<String,Object> record=queue.owned(owner,id);
        Path path=output(owner,id);
        if(Files.isRegularFile(path)||running.containsKey(id)) return status(owner,id);
        JSONObject body=JSON.parseObject(record.get("body").toString());
        ComposeJobPlan plan=body.getObject("composePlan",ComposeJobPlan.class);
        List<String> expected=plan.getTracks().getFileInfos().stream().map(file->file.getUrl()).toList();
        List<String> originals=request.get("inputs"), signed=request.get("serverUrls");
        if(!Objects.equals(expected,originals)||signed==null||signed.size()!=expected.size()) throw new ServiceException("合成素材签名与原任务不匹配");
        for(int i=0;i<signed.size();i++) plan.getTracks().getFileInfos().get(i).setUrl(signed.get(i));
        running.put(id,CompletableFuture.runAsync(()->{
            Path temporary=path.resolveSibling(path.getFileName()+".rendering.mp4");
            try {
                Files.createDirectories(path.getParent());
                renderer.renderManaged(plan,temporary);
                Files.move(temporary,path,StandardCopyOption.REPLACE_EXISTING);
            } catch(Exception error) {
                String reason=Objects.toString(error.getMessage(),"FFmpeg 未返回具体失败原因")
                    .replaceAll("(https?://[^\\s?\"']+)\\?[^\\s\"']+", "$1?***");
                reason=com.aid.media.provider.ProviderErrorSanitizer.safeMessage(reason,"FFmpeg 未返回具体失败原因");
                queue.update(owner,Map.of("id",id,"status","failed","error",reason));
            } finally {
                running.remove(id);
            }
        }));
        return Map.of("status","processing");
    }
    public Path download(Long owner,String id) {
        Path path=output(owner,id);
        if(!Files.isRegularFile(path)) throw new ServiceException("成片尚未就绪");
        return path;
    }
}
