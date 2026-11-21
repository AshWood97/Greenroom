package com.aid.greenroom;
import com.aid.media.provider.*;
import com.aid.media.dto.MediaAudioGenerateRequest;
import com.aid.domain.vo.AiModelConfigVo;
import java.util.*;
import org.springframework.stereotype.Component;
@Component
public class GreenroomAudioProvider implements AudioProviderClient {
    private final GreenroomQueue queue;
    public GreenroomAudioProvider(GreenroomQueue queue) { this.queue=queue; }
    public String protocol() { return "greenroom-audio"; }
    public boolean supportsProviderCode(String code) { return "greenroom".equals(code); }
    public ProviderSubmitResult submit(AiModelConfigVo config,MediaAudioGenerateRequest request) {
        Map<String,Object> body=new LinkedHashMap<>();
        body.put("model",config.getRealModelCode());
        String kind="minimax_music".equals(request.getBizTaskType()) ? "music" : "tts";
        if(kind.equals("music")) {
            String prompt=request.getTtsText();
            if(request.getOptions()!=null && request.getOptions().get("lyrics") instanceof String lyrics && !lyrics.isBlank() && !lyrics.equals(prompt)) prompt += "\n歌词：\n"+lyrics;
            body.put("prompt",prompt);
            if(request.getOptions()!=null) for(String field:List.of("duration","instrumental")) if(request.getOptions().containsKey(field)) body.put(field,request.getOptions().get(field));
            if(request.getOptions()!=null && request.getOptions().containsKey("isInstrumental")) body.put("instrumental",request.getOptions().get("isInstrumental"));
        } else {
            body.put("text",request.getTtsText());
            if(request.getVoiceCode()!=null) body.put("voice",request.getVoiceCode());
            if(request.getAudioFormat()!=null) body.put("response_format",request.getAudioFormat());
            if(request.getSpeechRate()!=null) body.put("speed",1D + request.getSpeechRate()/100D);
        }
        String id=request.getGreenroomSubmissionId();
        if (id==null && request.isPreviewMode()) id="aid-preview:"+UUID.randomUUID();
        return ProviderSubmitResult.builder().providerTaskId(queue.submit(id,kind,request.getUserId(),body)).build();
    }
    public ProviderTaskResult query(AiModelConfigVo config,String taskId) { return queue.query(taskId); }
}
