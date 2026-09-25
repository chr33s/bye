#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(ByeWidgetBridge, NSObject)
RCT_EXTERN_METHOD(publish:(NSString *)json)
RCT_EXTERN_METHOD(takePendingShare:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
@end
