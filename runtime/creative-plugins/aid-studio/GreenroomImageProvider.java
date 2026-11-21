package com.aid.greenroom;
import com.aid.media.provider.*;
import com.aid.media.dto.MediaImageGenerateRequest;
import com.aid.domain.vo.AiModelConfigVo;
import java.util.*;
import org.springframework.stereotype.Component;
@Component
public class GreenroomImageProvider implements ImageProviderClient {
    private final GreenroomQueue queue;
    public GreenroomImageProvider(GreenroomQueue queue) { this.queue=queue; }
    public String protocol() { return "greenroom-image"; }
    public boolean supportsProviderCode(String code) { return "greenroom".equals(code); }
    public ProviderSubmitResult submit(AiModelConfigVo config, MediaImageGenerateRequest request) {
        Map<String,Object> body=new LinkedHashMap<>();
        body.put("model",config.getRealModelCode()); body.put("prompt",request.getPrompt()); body.put("n",1);
        if(request.getSize()!=null) body.put("size",request.getSize().replace("*","x"));
        if(request.getNegativePrompt()!=null) body.put("providerParams",Map.of("negative_prompt",request.getNegativePrompt()));
        if(request.getMaskImageUrl()!=null) body.put("mask",request.getMaskImageUrl());
        if(request.getOptions()!=null && request.getOptions().get("aspectRatio")!=null) body.put("aspect_ratio",request.getOptions().get("aspectRatio"));
        List<Object> references=new ArrayList<>();
        if(request.getReferenceImageUrl()!=null) references.add(request.getReferenceImageUrl());
        if(request.getOptions()!=null && request.getOptions().get("referenceImages") instanceof List<?> values) references.addAll(values);
        if(request.getMaskImageUrl()!=null && references.isEmpty()) throw new com.aid.common.exception.ServiceException("蒙版编辑必须提供源图片");
        if(!references.isEmpty()) body.put("reference_images",references);
        return ProviderSubmitResult.builder().providerTaskId(queue.submit(request.getGreenroomSubmissionId(),"image",request.getUserId(),body)).build();
    }
    public ProviderTaskResult query(AiModelConfigVo config,String taskId) { return queue.query(taskId); }
}
