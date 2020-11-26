import { JsonServerResponse, ServerRequest } from './server'
import { isLooselyFalsy, loadDataFromRequest } from './utils'

const ALLOWED_METHODS = ['GET', 'POST']

export function getEvent(request: ServerRequest, response: JsonServerResponse): JsonServerResponse {
    if (!request.method || !ALLOWED_METHODS.includes(request.method)) {
        return response.json(
            405,
            {
                message: `Method ${request.method} not allowed! Try ${ALLOWED_METHODS.join(' or ')}.`,
            },
            {
                Allow: ALLOWED_METHODS.join(', '),
            }
        )
    }

    // Edge case for testing error handling
    if (request.body === '1337') throw new Error('Unexpected leet detected!')

    // TODO: statsd timer

    const now = new Date()

    let dataFromRequest
    let data
    try {
        dataFromRequest = loadDataFromRequest(request)
        data = dataFromRequest['data']
    } catch {
        return response.json(400, {
            message: "Malformed request data. Make sure you're sending valid JSON.",
        })
    }

    if (isLooselyFalsy(data))
        return response.json(400, {
            message:
                'No data found. Make sure to use a POST request when sending the payload in the body of the request.',
        })

    /*
        sent_at = _get_sent_at(data, request)

        token = _get_token(data, request)
        is_personal_api_key = False
        if not token:
            token = PersonalAPIKeyAuthentication.find_key(
                request, data_from_request["body"], data if isinstance(data, dict) else None
            )
            is_personal_api_key = True
        if not token:
            return cors_response(
                request,
                JsonResponse(
                    {
                        "message": "Neither api_key nor personal_api_key set. You can find your project API key in PostHog project settings.",
                    },
                    status=400,
                ),
            )
        
        team = Team.objects.get_team_from_token(token, is_personal_api_key)
        if team is None:
            return cors_response(
                request,
                JsonResponse(
                    {
                        "message": "Project or personal API key invalid. You can find your project API key in PostHog project settings.",
                    },
                    status=400,
                ),
            )
        
        if isinstance(data, dict):
            if data.get("batch"):  # posthog-python and posthog-ruby
                data = data["batch"]
                assert data is not None
            elif "engage" in request.path_info:  # JS identify call
                data["event"] = "$identify"  # make sure it has an event name
        
        if isinstance(data, list):
            events = data
        else:
            events = [data]
        
        for event in events:
            try:
                distinct_id = _get_distinct_id(event)
            except KeyError:
                return cors_response(
                    request,
                    JsonResponse(
                        {
                            "message": "You need to set user distinct ID field `distinct_id`.",
                            "item": event,
                        },
                        status=400,
                    ),
                )
            if "event" not in event:
                return cors_response(
                    request,
                    JsonResponse(
                        {"message": "You need to set event name field `event`.", "item": event},
                        status=400,
                    ),
                )
        
            process_event_ee(
                distinct_id=distinct_id,
                ip=get_ip_address(request),
                site_url=request.build_absolute_uri("/")[:-1],
                data=event,
                team_id=team.id,
                now=now,
                sent_at=sent_at,
            )
        
            if settings.LOG_TO_WAL:
                # log the event to kafka write ahead log for processing
                log_event(
                    distinct_id=distinct_id,
                    ip=get_ip_address(request),
                    site_url=request.build_absolute_uri("/")[:-1],
                    data=event,
                    team_id=team.id,
                    now=now,
                    sent_at=sent_at,
                )
*/

    return response.json(200, { status: 1 })
}
