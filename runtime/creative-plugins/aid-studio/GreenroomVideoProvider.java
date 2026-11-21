package com.aid.greenroom;
import com.aid.media.provider.*;
import com.aid.media.dto.MediaVideoGenerateRequest;
import com.aid.domain.vo.AiModelConfigVo;
import java.util.*;
import org.springframework.stereotype.Component;
@Component
public class GreenroomVideoProvider implements VideoProviderClient {
    private final GreenroomQueue queue;
    public GreenroomVideoProvider(GreenroomQueue queue) { this.queue=queue; }
    public String protocol() { return "greenroom-video"; }
    public boolean supportsProviderCode(String code) { return "greenroom".equals(code); }
    public ProviderSubmitResult submit(AiModelConfigVo config,MediaVideoGenerateRequest request) {
        Map<String,Object> body=new LinkedHashMap<>();
        body.put("model",config.getRealModelCode()); body.put("prompt",request.getPrompt());
        if(request.getImageUrl()!=null) body.put("image_url",request.getImageUrl());
        if(request.getAspectRatio()!=null) body.put("aspect_ratio",request.getAspectRatio());
        if(request.getDurationSeconds()!=null) body.put("duration",request.getDurationSeconds());
        if(request.getAudio()!=null) body.put("generate_audio",request.getAudio());
        if(request.getOptions()!=null) {
            Map<String,Object> options=request.getOptions();
            if(options.get("referenceImages") instanceof List<?> values) body.put("reference_image_urls",values);
            if(options.get("lastFrameImageUrl")!=null) body.put("last_frame_url",options.get("lastFrameImageUrl"));
            if(options.get("resolution")!=null) body.put("resolution",options.get("resolution"));
        }
        if(request.getResolvedReferenceVideos()!=null&&!request.getResolvedReferenceVideos().isEmpty()) body.put("reference_video_urls",request.getResolvedReferenceVideos().stream().map(value->value.getVideoUrl()).toList());
        if(request.getReferenceAudios()!=null&&!request.getReferenceAudios().isEmpty()) body.put("reference_audio_urls",request.getReferenceAudios().stream().map(value->value.getSampleUrl()).toList());
        return ProviderSubmitResult.builder().providerTaskId(queue.submit(request.getGreenroomSubmissionId(),"video",request.getUserId(),body)).build();
    }
    public ProviderTaskResult query(AiModelConfigVo config,String taskId) { return queue.query(taskId); }
}
